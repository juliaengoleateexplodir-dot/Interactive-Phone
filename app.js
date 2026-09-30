/* =========================================================================
   Luraph Deobfuscator — site
   Análise 100% client-side + geração de comando.
   Edite CONFIG.repo para o seu repositório.
   ========================================================================= */

const CONFIG = {
  repo: "Gang TKS/luraph-deobf",          // <- troque aqui
  filePlaceholder: "script.luau",
};

// ---------------- Luraph heuristics ----------------
const SIGNATURES = [
  { name: "Marcadores LPH_",           re: /LPH_[A-Za-z]/g,             weight: 35, tag: "core" },
  { name: "getfenv() / setfenv()",     re: /(get|set)fenv\s*\(/g,       weight: 10, tag: "vm"   },
  { name: "loadstring carregado",      re: /loadstring\s*\(/g,          weight: 6,  tag: "vm"   },
  { name: "Tabela de handlers",        re: /\{[^{}]*\[["'][A-Za-z0-9_]+["']\]\s*=\s*function/g, weight: 8, tag: "vm" },
  { name: "Dissecação por while+pc",   re: /\bpc\s*[+\-*/]?=\s*1|\bpc\b\s*<\s*#/g, weight: 8, tag: "vm" },
  { name: "bit32 pesado",              re: /bit32\.(bxor|band|bor|rshift|lshift)/g, weight: 8, tag: "crypto" },
  { name: "Escapes \\ddd",             re: /\\\d{2,3}/g,                 weight: 4,  tag: "crypto" },
  { name: "Referência a 'opcode'",     re: /opcode/i,                    weight: 6,  tag: "vm"   },
];

const NUMERIC_HINT = {
  // assinaturas fracas: linha gigante, muitas aspas, etc.
  longLine:  { threshold: 3000, weight: 18 },
  denseNonAscii: { threshold: 0.20, weight: 6 },
};

function analyze(text, filename) {
  const size = text.length;
  const lines = text.split(/\r?\n/);
  const lineCount = lines.length;
  let maxLineLen = 0;
  for (const l of lines) if (l.length > maxLineLen) maxLineLen = l.length;

  // contagem de sinais
  const signals = [];
  let score = 0;
  let totalMatches = 0;

  for (const sig of SIGNATURES) {
    const m = text.match(sig.re);
    const n = m ? m.length : 0;
    if (n) {
      totalMatches += n;
      // satura: pesos grandes ficam limitados
      const contribution = sig.weight * Math.min(1, Math.log10(n + 1));
      score += contribution;
      signals.push({ name: sig.name, count: n, tag: sig.tag });
    }
  }

  // linha gigante
  if (maxLineLen >= NUMERIC_HINT.longLine.threshold) {
    score += NUMERIC_HINT.longLine.weight;
    signals.push({ name: `Linha muito longa (${maxLineLen.toLocaleString("pt-BR")} caracteres)`, count: 1, tag: "shape" });
  }

  // densidade de não-ASCII (Luraph costuma evitar; se tiver muito, provavelmente não é Luraph)
  let nonAscii = 0;
  for (let i = 0; i < Math.min(size, 200000); i++) if (text.charCodeAt(i) > 127) nonAscii++;
  const dens = nonAscii / Math.min(size, 200000);
  if (dens > NUMERIC_HINT.denseNonAscii.threshold) {
    score -= 12;
    signals.push({ name: "Muitos caracteres não-ASCII (atípico em Luraph)", count: Math.round(dens * 100) + "%", tag: "shape", negative: true });
  }

  // razão código/tamanho: se for muito pequeno, não parece ofuscado
  if (size < 5000) {
    score -= 10;
    signals.push({ name: "Arquivo pequeno — pode não estar ofuscado", count: 1, tag: "shape", negative: true });
  }

  // clamp 0..100
  const conf = Math.max(0, Math.min(100, Math.round(score)));

  let verdict, pillClass;
  if (conf >= 70)      { verdict = "Luraph detectado"; pillClass = "pill"; }
  else if (conf >= 40) { verdict = "Provavelmente Luraph"; pillClass = "pill warn"; }
  else if (conf >= 15) { verdict = "Sinais fracos"; pillClass = "pill warn"; }
  else                 { verdict = "Não parece Luraph"; pillClass = "pill bad"; }

  return {
    filename, size, lineCount, maxLineLen,
    conf, verdict, pillClass, signals, totalMatches,
  };
}

// ---------------- helpers ----------------
function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}
function fmtInt(n) { return n.toLocaleString("pt-BR"); }

function shQuote(s) {
  if (!s) return '""';
  if (/^[A-Za-z0-9_./\-]+$/.test(s)) return s;
  return '"' + s.replace(/"/g, '\\"') + '"';
}

// ---------------- state ----------------
const state = {
  file: null,
  analysis: null,
};

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);

const dom = {
  drop: $("drop"),
  file: $("file"),
  pick: $("pick"),
  analysis: $("analysis"),
  fileName: $("file-name"),
  fileSub: $("file-sub"),
  reset: $("reset"),
  statSize: $("stat-size"),
  statLines: $("stat-lines"),
  statMaxline: $("stat-maxline"),
  statConf: $("stat-conf"),
  detectPill: $("detect-pill"),
  signals: $("signals"),
  cmdSection: $("comando"),
  cmd: $("cmd"),
  copy: $("copy"),
};

// ---------------- file handling ----------------
async function handleFile(file) {
  if (!file) return;
  state.file = file;

  // Heurística: se passar de ~8 MB, avisa (não trava, mas demora)
  const text = await file.text();

  const a = analyze(text, file.name);
  state.analysis = a;
  renderAnalysis(a);
  updateCommand();
}

function renderAnalysis(a) {
  dom.fileName.textContent = a.filename;
  dom.fileSub.textContent = "analisado localmente · nada foi enviado para servidor";
  dom.statSize.textContent = fmtBytes(a.size);
  dom.statLines.textContent = fmtInt(a.lineCount);
  dom.statMaxline.textContent = fmtInt(a.maxLineLen);
  dom.statConf.textContent = a.conf + "%";

  dom.detectPill.textContent = a.verdict;
  dom.detectPill.className = a.pillClass;

  dom.signals.innerHTML = "";
  if (a.signals.length === 0) {
    const li = document.createElement("li");
    li.textContent = "Nenhum sinal específico encontrado.";
    li.style.color = "var(--fg-dim)";
    dom.signals.appendChild(li);
  } else {
    for (const s of a.signals) {
      const li = document.createElement("li");
      const countTxt = typeof s.count === "number" ? ` ×${fmtInt(s.count)}` : "";
      li.textContent = s.name + countTxt;
      if (s.negative) li.style.color = "var(--warn)";
      dom.signals.appendChild(li);
    }
  }

  dom.analysis.hidden = false;
  dom.analysis.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ---------------- command generation ----------------
function buildCommand() {
  const a = state.analysis;
  const fname = a ? a.filename : CONFIG.filePlaceholder;

  const parts = ["python", "deob.py", shQuote(fname)];

  const obf = $("opt-obfuscator").value;
  if (obf && obf !== "auto") parts.push("--obfuscator", obf);

  const ex = $("opt-executor").value.trim();
  if (ex && ex !== "Wave") parts.push("--executor", shQuote(ex));

  const to = parseInt($("opt-timeout").value, 10);
  if (to && to !== 90) parts.push("--timeout", String(to));

  const bu = parseInt($("opt-budget").value, 10);
  if (bu && bu !== 30) parts.push("--budget", String(bu));

  const it = $("opt-input-text").value.trim();
  if (it) parts.push("--input-text", shQuote(it));

  if ($("opt-strings").checked)       parts.push("--strings");
  if ($("opt-debug").checked)         parts.push("--debug");
  if ($("opt-no-tidy").checked)       parts.push("--no-tidy");
  if ($("opt-no-fold").checked)       parts.push("--no-fold");
  if ($("opt-keep-preamble").checked) parts.push("--keep-preamble");
  if ($("opt-no-pypy").checked)       parts.push("--no-pypy");

  return parts.join(" ");
}

function updateCommand() {
  const cmd = buildCommand();
  dom.cmd.textContent = cmd;
  dom.cmdSection.hidden = false;
}

// ---------------- copy ----------------
async function copyCommand() {
  const txt = dom.cmd.textContent;
  try {
    await navigator.clipboard.writeText(txt);
    const old = dom.copy.innerHTML;
    dom.copy.innerHTML = "✓ Copiado";
    setTimeout(() => { dom.copy.innerHTML = old; }, 1400);
  } catch {
    // fallback antigo
    const ta = document.createElement("textarea");
    ta.value = txt; document.body.appendChild(ta);
    ta.select(); document.execCommand("copy"); ta.remove();
  }
}

// ---------------- wiring ----------------
function wireDropzone() {
  const dz = dom.drop;
  const openPicker = () => dom.file.click();
  dz.addEventListener("click", openPicker);
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
  });
  dom.pick.addEventListener("click", (e) => { e.stopPropagation(); openPicker(); });

  dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("dragover"); });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  dom.file.addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
  });

  dom.reset.addEventListener("click", () => {
    state.file = null; state.analysis = null;
    dom.file.value = "";
    dom.analysis.hidden = true;
    dom.cmdSection.hidden = true;
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function wireOptions() {
  const ids = [
    "opt-obfuscator","opt-executor","opt-timeout","opt-budget","opt-input-text",
    "opt-strings","opt-debug","opt-no-tidy","opt-no-fold","opt-keep-preamble","opt-no-pypy",
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener("change", updateCommand);
    el.addEventListener("input", updateCommand);
  }
}

function wireLinks() {
  const repoUrl = `https://github.com/${CONFIG.repo}`;
  const csUrl   = `https://codespaces.new/${CONFIG.repo}`;
  $("repo-link").href = repoUrl;
  $("codespaces-link").href = csUrl;
  $("codespaces-link-2").href = csUrl;
}

function wireCopy() {
  dom.copy.addEventListener("click", copyCommand);
}

document.addEventListener("DOMContentLoaded", () => {
  wireDropzone();
  wireOptions();
  wireLinks();
  wireCopy();
  updateCommand();          // mostra o comando default com placeholder
  dom.cmdSection.hidden = true;
});
