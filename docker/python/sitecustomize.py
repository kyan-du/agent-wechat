"""Python 3.10 compatibility shims loaded before runtime imports."""

import typing

try:
    from typing_extensions import NotRequired, Required
except ImportError:
    pass
else:
    if not hasattr(typing, "NotRequired"):
        typing.NotRequired = NotRequired
    if not hasattr(typing, "Required"):
        typing.Required = Required
