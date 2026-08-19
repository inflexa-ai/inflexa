# Author vision

This document demonstrates the refactoring, and how the systems should interact, from the perspective of the SWE that's driving this feature.

## Context:

Spike PR: https://github.com/inflexa-ai/inflexa/pull/291
Current state of the inflexa repo.
Research files in ./author_vision_research/

## Goals

- Minimize setup time and minimize the time-to-analysis of Inflexa Users.
- Users should be able to install custom packages and use them in their analysis.

### Technical direction that must be obeyed

(1) The current setup was built to work for both Inflexa CLI usage and for the Managed Inflexa service. We are giving up on that requirement, it must be designed with the CLI UX in mind.
(2) However, the harness package is shared between the CLI and the Managed Inflexa service. Thus, it must work in both contexts. In the managed service, it uses K8S. In order to accommodate maximum CLI UX (1), we must ensure that the harness does not break and it does not have regressions for the managed service.

## Current state

There are two image flavours: Python and Python+R. Each are pretty big, 10gb+ and 20gb+, respectively.
The user has to spend a lot of time looking at the image pull screen and that causes friction.
A bigger pain point is that the user cannot install custom packages. When the images are built, they're final and frozen. Cannot be extended

Moreover, the current local solution is based on a `current` pointer that's mounted to sandbox images. That's fixed somehow for the k8s managed solution such that it works for multiple concurrent analyses. But at some point in the Spike PR, we got into a state where a single farm could be active at a time, meaning that only one analysis can be worked on at a time. Which is a terrible limitation, and not something that we want to allow.

## Proposed solution, based on https://github.com/inflexa-ai/inflexa/pull/291 spike

### Docker images

We will build 2 images and a OCI bundle via ORAS.

- Provisioner image: contains the OS libraries, and the Python, R, C, Node (and whatever else is needed) in order to allow it to install & compile packages.
- Sandbox image: contains the required infrastructure and runtimes to allow it to run R, and Python code.
- OCI bundle: contains the compiled packages (via Provisioner image), and they're distribute via Github ORAS.
There will be an ARM and an AMD bundle. We will build both.
The bundle will be validated by the sandbox image. I.e., all the packages should be able to run in the sandbox. That means they're compiled/bundled/installed correctly.

#### What I don't like in the spike

I feel like the current sandbox image and the provisioner image have lots of flags and options, some were kept for backwards compatibility, and some are probably plain useless. We must ensure they're cleanly designed, that they're easy to use, and that they're not bloated.

The base images must be pinned by hash.
The images must be scanned by droast.
The images must be as slim as possible, we must employ Docker best practices.

### Packages

We are building and distributing some packages that we consider essential for Inflexa to work. These must be defined in a single place in the repository. Previously, (and in the spike), that place is images/lib-store-manifest.yaml.
Besides that, we are warming the caches for some packages, because otherwise we will put that burden on the user, which is a non-starter.

#### What I don't like in the spike

I don't like the lib-store-manifest.yaml file. It's an adhoc invention that is not well-designed. It must be redesigned. I have the following requirements:

- Each package must have a fixed version, and a commit hash. For example, in the JS world, we have the package-lock.json file, which contains the version and the commit hash of the package. Similarly, with `uv.lock` in python.
- Similarly for the R world where possible, we must follow best practices there. I don't know the R ecosystem, but based on the existing spike work, and further research, we should find the global maximum.

I don't like what we're shipping with the spike's implementation of the package store and of the farms on disk. They had so many ad-hoc files, some which contained packages randomly, without versions. When I looked inside a farm, I was confused. I didn't know what is the use of every file there. Ideally, I'd like the farms to have a fixed/shipped lock file similar to the standard ones.

The package warming problem - it is another ad-hoc invention.
At some point during the spike, we added a `warm` flag to the package manifest. However, now I don't even know if that's working or not. Because we later found out that package warming is a bit of a complex problem because of paths, because of numba caches, because it matters what the warming script does. We also decided to write some custom ad-hoc warming scripts. Same for matplotlib.

I think warming is a crucial part of the package building process, because it was estimated that scanpy and matplotlib could take up to 20-30 mins to load if the caches are not warm. That's clearly a non-starter for users. So we must do it when we're building the packages. Instead of the warm boolean flag, maybe it should accept a path to a warming script, that the provisioner could load and run when installing packages during the OCI building phase.

Once the user is setup, warming is still a problem. We decided that we should have a cache per analysis farm, that the sandboxes are mounting in write mode such that the cache is written and warmed with the user needs. And it can be re-used between runs, making everything faster.

When we create a new farm (on the moment of a new analysis), we copy the warmed cache that's shipped with the OCI bundle for the default packages.

### Inflexa farm usage

So we create a new farm when we create an analysis, but it shouldn't contain all the shipped packages. Instead, it is initially empty. The planning agent/conversation agent should pull in packages as the user wants to do analysis work. It should either for-see what packages are required, OR it should interview the user: "what packages do you want to use for this Run". Or, "hey we don't have this package installed, so we must do that" and prompt the user to install the package.

If by some chance the user and the agent is missing a package, then the execution agents should be able to link a package (i.e., they should be able to link an existing package from the lib store into the farm, because that is a simple operation. But they shouldn't be able to ask to install a new package - that's a tool that's not made available to them, also because a run is a backgrounded kind of process and it doesn't interact with the user once he's started).

To accommodate for this, we built some sort of a dependency graph. That may also be an ad-hoc invention, it must be checked (there is a research doc on this, and I think it's partially/fully implemented into the spike). The graph is used in the moment when we want to link a library into the farm, we also need to link every other lib it depends on. That's why we need this graph

### Inflexa setup

I think this was well scoped and almost well implemented in the spike, but we must do better.

So the idea is that during the setup phase, we have a boolean choice for the user, asking them if they want to install / download the sandbox images. The user must be informed that those are mandatory for inflexa to work correctly. It also spawns a job download for the OCI packages. That work is detached from the main process, and it has a lifecycle and it is also reported in the TUI. I think that we can do better now, with these directions.

1. We should do this at the start of the setup, not at the end. Why? Because we can start the download in the background, and the user can continue with the setup.
2. I think the download of the images should also be detached processes, like the download of the OCI packages. Why? To allow the user to go through the setup, without blocking them.
3. The setup screen should show a progress bar for all 3 downloads, and it should be updated in real time. This is also what's happening in the TUI.
4. If I'm done with the setup and I open the TUI, I should still see the progress bar of the required downloads as they're happening. And IF the user wants to interact with the chat, they can, BUT if they want to do work that requires the images and the OCI packages, they should be notified that they can't and that they must wait.
5. Once all downloads are done, the progress bars should disappear from the TUI. They're now being seen as "packages are ready", which is useless and takes up space.
6. There should be a TUI command to re-download the OCI packages and the images. For the images, on download, we should replace/delete old versions automatically. The user must be informed of this. For the OCI artifacts, packages should be merged. I.e., if I removed a package, and I got a new one, I keep them both (there is already some merging logic done).
