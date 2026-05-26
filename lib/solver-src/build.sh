#!/usr/bin/env bash
# Build lib/solver.wasm + lib/solver.mjs from wrapper.cpp using Emscripten.
#
# Required environment variables:
#   EMSDK_ROOT   Path to the emsdk installation directory
#                (e.g. export EMSDK_ROOT=/path/to/_solver_bench/emsdk)
#   EIGEN_ROOT   Path to the Eigen 3.4.0 source tree
#                (e.g. export EIGEN_ROOT=/path/to/_solver_bench/eigen-3.4.0)
#
# After setting both variables, run from any directory:
#   bash /path/to/lib/solver-src/build.sh
#
# The built solver.mjs and solver.wasm are copied into lib/ (the parent of
# this script's directory) and are safe to commit.

set -euo pipefail

if [ -z "${EMSDK_ROOT:-}" ]; then
  echo "ERROR: EMSDK_ROOT is not set." >&2
  echo "  export EMSDK_ROOT=/path/to/emsdk" >&2
  exit 1
fi

if [ -z "${EIGEN_ROOT:-}" ]; then
  echo "ERROR: EIGEN_ROOT is not set." >&2
  echo "  export EIGEN_ROOT=/path/to/eigen-3.4.0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "Activating emsdk from: ${EMSDK_ROOT}"

# Save paths before sourcing emsdk_env.sh — it unsets EMSDK_ROOT and EIGEN_ROOT.
_SAVED_EIGEN_ROOT="${EIGEN_ROOT}"
_EMSDK_PYTHON="${EMSDK_ROOT}/python/3.13.3_64bit/python.exe"
_EMCC_PY="${EMSDK_ROOT}/upstream/emscripten/emcc.py"

# shellcheck source=/dev/null
source "${EMSDK_ROOT}/emsdk_env.sh"

# On Windows Git Bash, 'emcc' (no extension) is not found even though the
# emscripten directory is on PATH (only emcc.bat / emcc.py exist there).
# Use a bash array so paths with spaces are handled correctly.
if command -v emcc &>/dev/null; then
  EMCC_CMD=(emcc)
elif [ -f "${_EMSDK_PYTHON}" ] && [ -f "${_EMCC_PY}" ]; then
  EMCC_CMD=("${_EMSDK_PYTHON}" "${_EMCC_PY}")
else
  echo "ERROR: emcc not found on PATH and emsdk Python fallback not available." >&2
  exit 1
fi

echo "Building wrapper.cpp ..."
"${EMCC_CMD[@]}" -O3 \
  -I "${_SAVED_EIGEN_ROOT}" \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createSolver \
  -sSTACK_SIZE=67108864 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_create,_destroy,_setPattern,_setValues,_analyze,_factorize,_solve,_factorNnz,_malloc,_free \
  -sEXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAP32,HEAPF64,HEAPU8 \
  -sENVIRONMENT=web,node \
  "${SCRIPT_DIR}/wrapper.cpp" \
  -o "${SCRIPT_DIR}/solver.mjs"

echo "Copying artifacts to lib/ ..."
cp "${SCRIPT_DIR}/solver.mjs"  "${LIB_DIR}/solver.mjs"
cp "${SCRIPT_DIR}/solver.wasm" "${LIB_DIR}/solver.wasm"

echo "Done. Built artifacts:"
echo "  ${LIB_DIR}/solver.mjs"
echo "  ${LIB_DIR}/solver.wasm"
