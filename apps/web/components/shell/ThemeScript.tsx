// Blocking, pre-paint theme bootstrap. Rendered in the root layout so it runs on
// EVERY page (login, public, app) BEFORE the browser paints the body — which is
// what prevents a light→dark flash on load. It is the single owner of how the
// `.dark` class is applied: it reads the saved preference (light | dark |
// system), toggles the class, mirrors it to `data-theme`, keeps following the OS
// while the preference is "system", and exposes `window.__getThemePref` /
// `window.__setTheme` for the ThemeToggle control to reuse. No React here on
// purpose: this must execute synchronously ahead of hydration.
const SCRIPT = `(function(){
  var KEY="theme";
  var mq=window.matchMedia("(prefers-color-scheme: dark)");
  function pref(){try{return localStorage.getItem(KEY)||"system"}catch(e){return "system"}}
  function resolve(p){return p==="dark"||p==="light"?p:(mq.matches?"dark":"light")}
  function apply(p){
    var mode=resolve(p);
    var r=document.documentElement;
    r.classList.toggle("dark",mode==="dark");
    r.setAttribute("data-theme",mode);
    r.style.colorScheme=mode;
  }
  window.__getThemePref=function(){return pref()};
  window.__setTheme=function(p){
    try{localStorage.setItem(KEY,p)}catch(e){}
    apply(p);
    window.dispatchEvent(new CustomEvent("themechange",{detail:p}));
  };
  apply(pref());
  try{mq.addEventListener("change",function(){if(pref()==="system")apply("system")})}catch(e){}
})();`;

export function ThemeScript() {
  // eslint-disable-next-line react/no-danger -- reason: intentional pre-paint inline script; content is a fixed constant, no user input.
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
