#!/usr/bin/env bash
# Common apt build toolchain for the sandbox-python and sandbox-python-r builder
# stages: base build tools plus the -dev headers that Python C extensions and
# Bioconductor source compiles link against. Stage-specific extra package names
# may be passed as arguments (e.g. python3-yaml for the R toolchain) so they
# install in the same apt transaction as the common set.
#
# Acquire::Retries: archive.ubuntu.com sits behind flaky round-robin mirrors; the
# apt default of zero retries occasionally drops the whole invocation, so a small
# retry/timeout budget is written before the update.
set -eux

printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\nAcquire::https::Timeout "30";\n' \
  > /etc/apt/apt.conf.d/80-retries

apt-get update
apt-get install -y --no-install-recommends \
  build-essential cmake pkg-config gfortran make \
  python3-dev python3-venv \
  libbz2-dev liblzma-dev zlib1g-dev libzstd-dev libffi-dev \
  libssl-dev libxml2-dev libcurl4-openssl-dev libgit2-dev \
  libhdf5-dev libnetcdf-dev libopenblas-dev liblapack-dev \
  libeigen3-dev libfftw3-dev \
  libgdal-dev libgeos-dev libproj-dev libsqlite3-dev libudunits2-dev \
  libtiff-dev libjpeg-dev libpng-dev libgl1 libglib2.0-0 \
  libcairo2-dev libfreetype6-dev libfontconfig1-dev \
  libharfbuzz-dev libfribidi-dev \
  libpango1.0-dev libgdk-pixbuf-2.0-dev \
  libmagick++-dev libgsl-dev \
  swig \
  curl wget git jq \
  "$@"

rm -rf /var/lib/apt/lists/*
