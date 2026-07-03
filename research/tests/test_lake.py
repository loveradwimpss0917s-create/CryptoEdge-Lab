"""io/lake.py's R2-config helpers (2026-07: found live, against real R2,
that pyarrow's endpoint_override must not include a scheme — see
_split_scheme's docstring for the exact failure this guards against)."""

from __future__ import annotations

import pytest

from cryptoedge_research.io.lake import _r2_config, _split_scheme


def test_split_scheme_strips_https_prefix():
    assert _split_scheme("https://abc123.r2.cloudflarestorage.com") == (
        "https",
        "abc123.r2.cloudflarestorage.com"
    )


def test_split_scheme_defaults_to_https_when_no_scheme_present():
    assert _split_scheme("abc123.r2.cloudflarestorage.com") == ("https", "abc123.r2.cloudflarestorage.com")


def test_r2_config_raises_a_clear_error_when_unset(monkeypatch):
    monkeypatch.delenv("CRYPTOEDGE_R2_ENDPOINT", raising=False)
    monkeypatch.delenv("CRYPTOEDGE_R2_BUCKET", raising=False)
    with pytest.raises(RuntimeError, match="CRYPTOEDGE_R2_ENDPOINT"):
        _r2_config()


def test_r2_config_raises_a_clear_error_when_empty_string(monkeypatch):
    # A GitHub Actions secret referenced but never configured resolves to
    # an empty string, not a missing env var — this is the actual failure
    # mode that mattered in production.
    monkeypatch.setenv("CRYPTOEDGE_R2_ENDPOINT", "")
    monkeypatch.setenv("CRYPTOEDGE_R2_BUCKET", "cryptoedge-lake")
    with pytest.raises(RuntimeError, match="CRYPTOEDGE_R2_ENDPOINT"):
        _r2_config()


def test_r2_config_returns_both_values_when_set(monkeypatch):
    monkeypatch.setenv("CRYPTOEDGE_R2_ENDPOINT", "https://abc123.r2.cloudflarestorage.com")
    monkeypatch.setenv("CRYPTOEDGE_R2_BUCKET", "cryptoedge-lake")
    assert _r2_config() == ("https://abc123.r2.cloudflarestorage.com", "cryptoedge-lake")
