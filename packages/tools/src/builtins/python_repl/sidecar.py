"""JSON-line REPL sidecar for the `execute_code` tool.

Protocol (one JSON object per line, both directions):
  Request:  {"code": "<source>"}
  Response: {"stdout": "...", "stderr": "...", "value": "...", "ok": true}
            {"stderr": "<traceback>", "ok": false}

State (the `_ns` namespace) persists across calls — variables, imports,
and function definitions defined in one call are visible in the next.

Started once per agent process by the TS wrapper. Stdin/stdout are
binary-safe via JSON encoding; all output is captured via redirect_stdout
/ redirect_stderr to keep the stdio channel free for protocol traffic.
"""

import sys
import json
import io
import ast
import traceback
from contextlib import redirect_stdout, redirect_stderr

_ns: dict = {"__name__": "__openacme__"}


def _run(code: str) -> dict:
    """Compile then exec; if the trailing statement is an expression, also
    return its repr as `value` (mirrors a Jupyter cell's last-expression
    behavior)."""
    out_buf = io.StringIO()
    err_buf = io.StringIO()
    value_repr = ""
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError:
        return {
            "stdout": "",
            "stderr": traceback.format_exc(),
            "value": "",
            "ok": False,
        }

    last_expr = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        last_expr = tree.body.pop()

    try:
        with redirect_stdout(out_buf), redirect_stderr(err_buf):
            if tree.body:
                exec(compile(tree, "<openacme>", "exec"), _ns)
            if last_expr is not None:
                value = eval(
                    compile(ast.Expression(last_expr.value), "<openacme>", "eval"),
                    _ns,
                )
                if value is not None:
                    value_repr = repr(value)
    except SystemExit:
        # Don't let the agent's code kill the sidecar.
        return {
            "stdout": out_buf.getvalue(),
            "stderr": err_buf.getvalue() + "SystemExit suppressed in REPL\n",
            "value": "",
            "ok": False,
        }
    except BaseException:
        return {
            "stdout": out_buf.getvalue(),
            "stderr": err_buf.getvalue() + traceback.format_exc(),
            "value": "",
            "ok": False,
        }

    return {
        "stdout": out_buf.getvalue(),
        "stderr": err_buf.getvalue(),
        "value": value_repr,
        "ok": True,
    }


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            sys.stdout.write(json.dumps({
                "stdout": "",
                "stderr": f"sidecar protocol error: {e}",
                "value": "",
                "ok": False,
            }) + "\n")
            sys.stdout.flush()
            continue
        result = _run(str(req.get("code", "")))
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
