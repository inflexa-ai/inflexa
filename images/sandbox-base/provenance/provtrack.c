/*
 * provtrack.c — LD_PRELOAD shared library for file-read provenance tracking.
 *
 * Intercepts open(), openat(), fopen(), and fopen64() at the libc level.
 * Read-mode opens within configured data directory prefixes are reported
 * to the sandbox-server via a Unix domain socket (SOCK_DGRAM).
 *
 * Compile: gcc -shared -fPIC -o provtrack.so provtrack.c -ldl -pthread
 *
 * This library does NOT affect the Go sandbox-server (statically linked,
 * CGO_ENABLED=0). Only dynamically-linked Python/R processes are affected.
 */

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

/* ── Configuration ─────────────────────────────────────────────── */

#define MAX_PREFIXES 16
#define MAX_SEEN 32768

/* Protects init and the dedup table (seen_paths/seen_count).
 * PTHREAD_MUTEX_INITIALIZER requires no runtime init call. */
static pthread_mutex_t prov_mu = PTHREAD_MUTEX_INITIALIZER;

static const char *prov_socket_path = NULL;
static const char *prefixes[MAX_PREFIXES];
static int prefix_count = 0;

/* Simple dedup: linear scan of seen (path|op) keys */
static char *seen_keys[MAX_SEEN];
static int seen_count = 0;

static int initialized = 0;

/* ── Real libc function pointers ──────────────────────────────── */

static int (*real_open)(const char *, int, ...) = NULL;
static int (*real_open64)(const char *, int, ...) = NULL;
static int (*real_openat)(int, const char *, int, ...) = NULL;
static int (*real_openat64)(int, const char *, int, ...) = NULL;
static FILE *(*real_fopen)(const char *, const char *) = NULL;
static FILE *(*real_fopen64)(const char *, const char *) = NULL;
static int (*real_unlink)(const char *) = NULL;
static int (*real_remove)(const char *) = NULL;

static int debug_enabled = 0;

/* ── Init ─────────────────────────────────────────────────────── */

static void init(void) {
    if (initialized) return;  /* fast path — no lock */

    pthread_mutex_lock(&prov_mu);
    if (initialized) {
        pthread_mutex_unlock(&prov_mu);
        return;
    }

    real_open = dlsym(RTLD_NEXT, "open");
    real_open64 = dlsym(RTLD_NEXT, "open64");
    real_openat = dlsym(RTLD_NEXT, "openat");
    real_openat64 = dlsym(RTLD_NEXT, "openat64");
    real_fopen = dlsym(RTLD_NEXT, "fopen");
    real_fopen64 = dlsym(RTLD_NEXT, "fopen64");
    real_unlink = dlsym(RTLD_NEXT, "unlink");
    real_remove = dlsym(RTLD_NEXT, "remove");

    debug_enabled = (getenv("PROVENANCE_DEBUG") != NULL);

    prov_socket_path = getenv("PROVENANCE_SOCKET");

    /* Parse colon-separated prefix list */
    const char *raw = getenv("PROVENANCE_DATA_PREFIXES");
    if (!raw) raw = "/data/";

    /* Work on a copy since strtok mutates */
    char *buf = strdup(raw);
    if (buf) {
        char *tok = strtok(buf, ":");
        while (tok && prefix_count < MAX_PREFIXES) {
            prefixes[prefix_count++] = strdup(tok);
            tok = strtok(NULL, ":");
        }
        free(buf);
    }

    initialized = 1;
    pthread_mutex_unlock(&prov_mu);
}

/* ── Helpers ──────────────────────────────────────────────────── */

static int matches_prefix(const char *path) {
    for (int i = 0; i < prefix_count; i++) {
        if (strncmp(path, prefixes[i], strlen(prefixes[i])) == 0)
            return 1;
    }
    return 0;
}

/* Caller must hold prov_mu. Key format: "path|op" (matches Python/R dedup). */
static int already_seen(const char *key) {
    if (seen_count >= MAX_SEEN) return 0;  /* dedup table full, allow */
    for (int i = 0; i < seen_count; i++) {
        if (strcmp(seen_keys[i], key) == 0) return 1;
    }
    return 0;
}

/* Caller must hold prov_mu. */
static void mark_seen(const char *key) {
    if (seen_count >= MAX_SEEN) return;
    seen_keys[seen_count++] = strdup(key);
}

static void send_provenance(const char *path, const char *op) {
    if (!prov_socket_path || !prov_socket_path[0]) return;

    /* Resolve to absolute path */
    char abspath[PATH_MAX];
    if (path[0] == '/') {
        strncpy(abspath, path, PATH_MAX - 1);
        abspath[PATH_MAX - 1] = '\0';
    } else {
        if (!realpath(path, abspath)) return;
    }

    if (!matches_prefix(abspath)) return;

    /* Dedup by (path, op) — same file can be both read and written */
    char dedup_key[PATH_MAX + 16];
    snprintf(dedup_key, sizeof(dedup_key), "%s|%s", abspath, op);

    pthread_mutex_lock(&prov_mu);
    if (already_seen(dedup_key)) {
        pthread_mutex_unlock(&prov_mu);
        return;
    }
    mark_seen(dedup_key);
    pthread_mutex_unlock(&prov_mu);

    /* Escape backslashes and double-quotes in the path before embedding in JSON */
    char escaped[PATH_MAX * 2];
    int ei = 0;
    for (int pi = 0; abspath[pi] && ei < (int)sizeof(escaped) - 3; pi++) {
        if (abspath[pi] == '\\' || abspath[pi] == '"') escaped[ei++] = '\\';
        escaped[ei++] = abspath[pi];
    }
    escaped[ei] = '\0';

    /* Build JSON message */
    char msg[PATH_MAX * 2 + 256];
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    double t = ts.tv_sec + ts.tv_nsec / 1e9;
    int len = snprintf(msg, sizeof(msg),
        "{\"t\":%.6f,\"p\":\"%s\",\"pid\":%d,\"layer\":\"preload\",\"op\":\"%s\"}",
        t, escaped, getpid(), op);
    if (len < 0 || (size_t)len >= sizeof(msg)) return;

    /* Send via Unix datagram socket */
    int sock = socket(AF_UNIX, SOCK_DGRAM, 0);
    if (sock < 0) return;

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, prov_socket_path, sizeof(addr.sun_path) - 1);

    ssize_t sent = sendto(sock, msg, len, MSG_DONTWAIT,
                          (struct sockaddr *)&addr, sizeof(addr));
    if (sent < 0 && debug_enabled) {
        fprintf(stderr, "[provtrack] sendto failed for %s: %s\n", abspath, strerror(errno));
    }
    close(sock);
}

static const char *classify_flags(int flags) {
    int accmode = flags & O_ACCMODE;
    if (accmode == O_RDONLY && !(flags & O_CREAT))
        return "read";
    return "write";
}

static const char *classify_mode_str(const char *mode) {
    if (!mode) return NULL;
    if (mode[0] == 'r' && mode[1] != '+') return "read";
    if (mode[0] == 'w' || mode[0] == 'a' || mode[0] == 'x') return "write";
    if (mode[0] == 'r' && mode[1] == '+') return "write";
    return NULL;
}

/* ── Interceptors ─────────────────────────────────────────────── */

static void debug_log(const char *func, const char *path) {
    if (debug_enabled && path && matches_prefix(path)) {
        fprintf(stderr, "[provtrack] %s: %s\n", func, path);
    }
}

int open(const char *path, int flags, ...) {
    init();
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    debug_log("open", path);
    int fd = real_open ? real_open(path, flags, mode) : -1;
    if (fd >= 0) send_provenance(path, classify_flags(flags));
    return fd;
}

int open64(const char *path, int flags, ...) {
    init();
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    debug_log("open64", path);
    int fd = real_open64 ? real_open64(path, flags, mode) : -1;
    if (fd >= 0) send_provenance(path, classify_flags(flags));
    return fd;
}

int openat(int dirfd, const char *path, int flags, ...) {
    init();
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    debug_log("openat", path);
    int fd = real_openat ? real_openat(dirfd, path, flags, mode) : -1;
    if (fd >= 0) {
        if (path[0] == '/' || dirfd == AT_FDCWD) {
            send_provenance(path, classify_flags(flags));
        } else {
            /* Relative path with explicit dirfd — resolve via /proc/self/fd */
            char dirpath[PATH_MAX];
            char fullpath[PATH_MAX];
            char proclink[64];
            snprintf(proclink, sizeof(proclink), "/proc/self/fd/%d", dirfd);
            ssize_t len = readlink(proclink, dirpath, sizeof(dirpath) - 1);
            if (len > 0) {
                dirpath[len] = '\0';
                snprintf(fullpath, sizeof(fullpath), "%s/%s", dirpath, path);
                send_provenance(fullpath, classify_flags(flags));
            }
        }
    }
    return fd;
}

int openat64(int dirfd, const char *path, int flags, ...) {
    init();
    mode_t mode = 0;
    if (flags & O_CREAT) {
        va_list ap;
        va_start(ap, flags);
        mode = (mode_t)va_arg(ap, int);
        va_end(ap);
    }
    debug_log("openat64", path);
    int fd = real_openat64 ? real_openat64(dirfd, path, flags, mode) : -1;
    if (fd >= 0) {
        if (path[0] == '/' || dirfd == AT_FDCWD) {
            send_provenance(path, classify_flags(flags));
        } else {
            /* Relative path with explicit dirfd — resolve via /proc/self/fd */
            char dirpath[PATH_MAX];
            char fullpath[PATH_MAX];
            char proclink[64];
            snprintf(proclink, sizeof(proclink), "/proc/self/fd/%d", dirfd);
            ssize_t len = readlink(proclink, dirpath, sizeof(dirpath) - 1);
            if (len > 0) {
                dirpath[len] = '\0';
                snprintf(fullpath, sizeof(fullpath), "%s/%s", dirpath, path);
                send_provenance(fullpath, classify_flags(flags));
            }
        }
    }
    return fd;
}

FILE *fopen(const char *path, const char *mode) {
    init();
    FILE *fp = real_fopen ? real_fopen(path, mode) : NULL;
    const char *op = classify_mode_str(mode);
    if (fp && op) {
        send_provenance(path, op);
    }
    return fp;
}

FILE *fopen64(const char *path, const char *mode) {
    init();
    FILE *fp = real_fopen64 ? real_fopen64(path, mode) : NULL;
    const char *op = classify_mode_str(mode);
    if (fp && op) {
        send_provenance(path, op);
    }
    return fp;
}

int unlink(const char *path) {
    init();
    if (!real_unlink) real_unlink = dlsym(RTLD_NEXT, "unlink");
    int ret = real_unlink ? real_unlink(path) : -1;
    if (ret == 0) {
        send_provenance(path, "delete");
    }
    return ret;
}

int remove(const char *path) {
    init();
    if (!real_remove) real_remove = dlsym(RTLD_NEXT, "remove");
    int ret = real_remove ? real_remove(path) : -1;
    if (ret == 0) {
        send_provenance(path, "delete");
    }
    return ret;
}
