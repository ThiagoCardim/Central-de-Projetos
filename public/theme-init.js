// Aplica o tema salvo antes do primeiro paint (evita flash). Tema padrão: dark.
try {
  var t = localStorage.getItem("yc-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
