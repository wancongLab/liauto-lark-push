/**
 * 自测：签名校验 + 加密事件解密（复刻飞书官方格式）
 */
import { createHash, createCipheriv, randomBytes } from "node:crypto";
import { verifySignature, decryptEvent } from "../src/lib/feishu.js";

const KEY = "test-encrypt-key-123456";
const BODY = JSON.stringify({ type: "event_callback", event: { hello: "世界" } });

// ---- 签名 ----
const ts = String(Date.now());
const nonce = "abc123nonce";
const expect = createHash("sha256").update(ts + nonce + KEY + BODY, "utf8").digest("hex");
const headers = new Headers({
  "X-Lark-Request-Timestamp": ts,
  "X-Lark-Request-Nonce": nonce,
  "X-Lark-Signature": expect,
});
console.log("签名正确 →", verifySignature(headers, BODY, KEY));
const badHeaders = new Headers({ ...Object.fromEntries(headers), "X-Lark-Signature": "deadbeef" });
console.log("签名错误 →", verifySignature(badHeaders, BODY, KEY));
console.log("未配密钥 →", verifySignature(headers, BODY, null));

// ---- 加密事件 ----
const key = createHash("sha256").update(KEY, "utf8").digest();
const msg = Buffer.from(BODY, "utf8");
const plain = Buffer.concat([
  randomBytes(16),
  (() => { const b = Buffer.alloc(4); b.writeUInt32BE(msg.length); return b; })(),
  msg,
  Buffer.from("cli_test_app", "utf8"),
]);
const iv = randomBytes(16);
const cipher = createCipheriv("aes-256-cbc", key, iv);
const enc = Buffer.concat([iv, cipher.update(plain), cipher.final()]).toString("base64");
const out = decryptEvent(enc, KEY);
console.log("解密结果 →", JSON.stringify(out), "| 与原文一致:", JSON.stringify(out) === BODY);
