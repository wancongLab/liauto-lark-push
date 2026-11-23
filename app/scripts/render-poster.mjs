/**
 * 渲染 3D 车模海报图（Web 面板的 poster 兜底 + 分享图）
 *
 * 用法：
 *   1. 起一个静态服务器把 public/ 暴露出去
 *   2. 用无头浏览器打开 scripts/_poster.html 并截图
 *   3. 输出 public/car-poster.png
 *
 * 已验证：three.js + RoomEnvironment + MeshStandardMaterial 渲染银色金属漆效果成立。
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = 8979;
const HTML = `<!doctype html><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.160.0/build/three.module.js","three/addons/":"https://unpkg.com/three@0.160.0/examples/jsm/"}}</script>
<style>html,body{margin:0;height:100%;background:#0e1319;overflow:hidden}canvas{display:block}</style>
<script type="module">
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
const scene=new THREE.Scene(); scene.background=new THREE.Color(0x0e1319);
const cam=new THREE.PerspectiveCamera(30,1400/820,0.1,5000);
const r=new THREE.WebGLRenderer({antialias:true}); r.setSize(1400,820);
document.body.appendChild(r.domElement);
const pmrem=new THREE.PMREMGenerator(r); scene.environment=pmrem.fromScene(new RoomEnvironment(),0.04).texture;
scene.add(new THREE.HemisphereLight(0xffffff,0x33465c,1.1));
const d=new THREE.DirectionalLight(0xffffff,1.6); d.position.set(120,180,80); scene.add(d);
const d2=new THREE.DirectionalLight(0x9fc4ff,0.8); d2.position.set(-150,60,-120); scene.add(d2);
new GLTFLoader().load('/car.glb',(g)=>{
  const root=g.scene; scene.add(root);
  const box=new THREE.Box3().setFromObject(root); const size=new THREE.Vector3(); box.getSize(size);
  const c=new THREE.Vector3(); box.getCenter(c); root.position.sub(c);
  root.traverse(o=>{ if(o.isMesh){ o.material=new THREE.MeshStandardMaterial({
    color:0x9aa2ad, metalness:0.85, roughness:0.30, envMapIntensity:1.35 }); }});
  const rad=Math.max(size.x,size.z,size.y);
  cam.position.set(rad*0.95, rad*0.42, rad*1.05); cam.lookAt(0,0,0);
  r.render(scene,cam);
  document.title='READY';
},undefined,(e)=>{document.title='ERR';});
</script>`;

const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0];
  if (p === "/" ) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(HTML); }
  if (p === "/car.glb") {
    // 用非 Draco 版渲染（SwiftShader 解码 Draco 743k 面太慢会渲染空白）
    const buf = fs.readFileSync(path.join(ROOT, "scripts", "car-render.glb"));
    res.writeHead(200, { "Content-Type": "model/gltf-binary" }); return res.end(buf);
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, "127.0.0.1", async () => {
  const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
  const out = path.join(ROOT, "public", "car-poster.png");
  const args = ["--headless=new", "--enable-unsafe-swiftshader", "--no-sandbox", "--no-first-run",
    "--disable-extensions", "--user-data-dir=/tmp/edge-poster", "--hide-scrollbars",
    "--window-size=1400,820", "--virtual-time-budget=45000", `--screenshot=${out}`,
    `http://127.0.0.1:${PORT}/`];
  const p = spawn(EDGE, args, { stdio: "ignore" });
  setTimeout(() => { p.kill(); server.close(); console.log("poster →", out); }, 55000);
});
