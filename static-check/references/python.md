# Python Static Check Reference

## Detect

- `pyproject.toml`, `setup.cfg`, `requirements*.txt`, `poetry.lock`, `uv.lock`, `tox.ini`, `noxfile.py`, `mypy.ini`, `pytest.ini`.

## Gates

- If no repo command covers the gate, consider formatter check, Ruff/Flake8/Pylint, MyPy/Pyright, import sorting, Bandit, dependency audit.
- For packages, verify metadata, entry points, dependency ranges, import paths, and Python version compatibility.

## Safe Repair

- Formatter, Ruff autofix, import sorting, and simple unused import removal are safe when repo tooling supports them.
- Do not auto-change exception behavior, typing contracts, async behavior, or packaging compatibility.
