export const THEME_KEY = "k3g-theme";
export type Theme = "light" | "dark";

/** Script inline no <head>: tema claro é o padrão; escuro só se o usuário escolheu. */
export const themeInitScript = `try{if(localStorage.getItem("${THEME_KEY}")==="dark")document.documentElement.classList.add("dark")}catch(e){}`;
