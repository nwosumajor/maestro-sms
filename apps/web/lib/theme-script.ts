// The pre-paint theme bootstrap, kept apart from the component so its CSP hash
// can be stated next to it and checked against it.
//
// It has to be INLINE and blocking: it runs before the browser paints, so the
// page never flashes light before turning dark. That makes it the one script on
// the page a strict `script-src` cannot wave through — `'self'` does not cover
// inline code, and it is not injected by anything Next has already trusted.
//
// A HASH rather than a nonce, deliberately. A nonce would mean reading the
// request headers in the root layout, which makes EVERY route dynamic and costs
// the public marketing pages their static generation. The script is a fixed
// constant, so its hash is stable and free.
//
// `theme-script.test.ts` recomputes the hash from this exact string. If the
// script is edited and the hash is not, the test fails — which is the point: a
// stale hash silently blocks the script, and the only symptom is the app
// loading in the wrong theme.
export const THEME_SCRIPT = `(function(){
  var KEY="theme";
  var mq=window.matchMedia("(prefers-color-scheme: dark)");
  function pref(){try{return localStorage.getItem(KEY)||"dark"}catch(e){return "dark"}}
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

/** The CSP source expression permitting THEME_SCRIPT. Keep in step with it. */
export const THEME_SCRIPT_CSP_HASH = "sha256-6JLTKdKgKJQArWjE2YsuBsgItuqdBA0jlGBjWz/YwmY=";
