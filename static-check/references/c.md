# C Static Check Reference

## Detect

- `.c`, `.h`, CMake/Make/Bazel C targets, `compile_commands.json`, C compiler flags, sanitizer or Clang-Tidy configs.

## Gates

- If repo build/test commands do not cover the gate, consider compiler warnings as errors, Clang-Tidy, Cppcheck where used, ASan/UBSan/TSan, fuzz smoke tests, dependency/license scans.
- Use the project's configured compiler, standard version, target platform, and warning policy.

## Safe Repair

- Formatter or include ordering only when repo tooling defines it.
- Do not rewrite ownership, allocation, threading, or ABI behavior as an autofix.
