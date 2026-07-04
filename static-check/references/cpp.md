# C++ Static Check Reference

## Detect

- `.cc`, `.cpp`, `.cxx`, `.hpp`, `.hh`, CMake/Make/Bazel C++ targets, `compile_commands.json`, Clang-Tidy configs, sanitizer configs.

## Gates

- If repo build/test commands do not cover the gate, consider Clang-Tidy, compiler warnings as errors, Cppcheck where used, ASan/UBSan/TSan, fuzz smoke tests, dependency/license scans.
- Use the project's configured compiler, standard version, STL policy, exception policy, and ABI constraints.

## Safe Repair

- Formatter, include ordering, and mechanical Clang-Tidy fixes only when repo tooling defines them.
- Do not rewrite ownership, lifetime, templates, exceptions, threading, or ABI behavior as an autofix.
