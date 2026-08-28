"""CPU-quota visibility for Python in Inflexa sandbox containers.

`os.cpu_count()` reports the cores of the machine. A cgroup CPU quota does not
change it. Thus a pool that sizes itself from that number forks one worker for
each core of the host, inside a container that has a fraction of them. Each fork
copies its working set, thus the forks exhaust the memory limit of the container
before the CPU limit throttles them.

sandbox-server publishes the quota of the container as INFLEXA_CPU_LIMIT, and
this module makes `os.cpu_count()` report it. `multiprocessing.cpu_count()`,
`multiprocessing.Pool()`, and both pools of `concurrent.futures` read that one
function at call time, thus each of them gets the quota.

CPython 3.13 gives the same control through PYTHON_CPU_COUNT. This module is the
equivalent for the 3.12 interpreter of this image.

`os.sched_getaffinity` stays as it is, because it reports a set of processor
numbers and a quota removes no processor from that set. The conda interpreter of
the library store has its own site directory, thus this module does not reach
it. The thread-count variables that sandbox-server publishes do reach it.

The .pth file beside this module imports it at interpreter start. It does
nothing when the variable is absent, which is the state of a container that has
no quota.
"""

import os


def _quota() -> int:
    """The published quota, or 0 when there is none to publish."""
    try:
        limit = int(os.environ.get("INFLEXA_CPU_LIMIT", ""))
    except ValueError:
        return 0
    return limit if limit >= 1 else 0


_LIMIT = _quota()

if _LIMIT:

    def _cpu_count() -> int:
        """Report the quota of the container, not the cores of the machine."""
        return _LIMIT

    os.cpu_count = _cpu_count
    # Present from CPython 3.13. Kept in step so a later base image needs no
    # change here.
    if hasattr(os, "process_cpu_count"):
        os.process_cpu_count = _cpu_count
