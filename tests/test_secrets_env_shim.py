"""docker/secrets-env.sh: /run/secrets/* -> env vars (deploy plan §4.2). Runs the real script against a temp secrets dir."""
import subprocess
from pathlib import Path

SHIM = Path(__file__).resolve().parents[1] / "docker" / "secrets-env.sh"


def _run(tmp_path, env=None):
    sec = tmp_path / "secrets"
    sec.mkdir()
    (sec / "FOO").write_text("fromfile")
    (sec / "KEEP").write_text("fromfile")
    (sec / "foo.bar").write_text("ignored")
    script = SHIM.read_text().replace("/run/secrets", str(sec))
    out = subprocess.run(
        ["sh", "-c", f'{script}\necho "FOO=$FOO"; echo "KEEP=$KEEP"; env'],
        capture_output=True, text=True, env={"PATH": "/usr/bin:/bin", **(env or {})}, check=True,
    ).stdout
    return out


def test_secret_file_becomes_env_var(tmp_path):
    assert "FOO=fromfile" in _run(tmp_path)


def test_existing_env_var_not_overwritten(tmp_path):
    assert "KEEP=preset" in _run(tmp_path, {"KEEP": "preset"})


def test_non_name_shaped_files_ignored(tmp_path):
    assert "foo.bar" not in _run(tmp_path)
