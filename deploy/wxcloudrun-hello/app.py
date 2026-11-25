# 微信云托管最小示例
# 目的：验证「容器能在云托管跑起来 + 小程序能调通」这条链路
# 只用标准库，无第三方依赖，构建最快，不会因为 pip 网络问题失败
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.getenv("PORT", "80"))


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload, ctype="application/json; charset=utf-8"):
        if isinstance(payload, bytes):
            body = payload
        elif isinstance(payload, str):
            body = payload.encode("utf-8")
        else:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "service": "hermes-agent"})
        elif self.path == "/":
            self._send(200, "hello from 微信云托管", "text/plain; charset=utf-8")
        else:
            self._send(404, {"error": "not found", "path": self.path})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            data = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            data = {"raw": raw}
        # 通过 callContainer 调用时，云托管会自动注入 X-WX-OPENID 等请求头
        self._send(200, {
            "ok": True,
            "path": self.path,
            "received": data,
            "openid": self.headers.get("X-WX-OPENID", ""),
        })

    def log_message(self, fmt, *args):
        print("[%s] %s" % (self.log_date_time_string(), fmt % args), flush=True)


if __name__ == "__main__":
    print("listening on 0.0.0.0:%d" % PORT, flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
