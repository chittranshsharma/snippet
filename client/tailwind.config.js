/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        // Minimalist-arcade palette: bone on void, one amber phosphor.
        void: "#0A0B0D",
        cabinet: "#131418",
        rule: "#24262C",
        bone: "#ECEAE1",
        dim: "#777C85",
        amber: "#FFB000",
        good: "#34D27B", // correct — reveal only
        bad: "#FF5C5C", // wrong / error — reveal only
      },
      fontFamily: {
        marquee: ["Archivo", "system-ui", "sans-serif"],
        console: ['"Space Mono"', "ui-monospace", "monospace"],
        coin: ['"Press Start 2P"', "ui-monospace", "monospace"],
      },
      keyframes: {
        blink: { "50%": { opacity: "0" } },
        flicker: {
          "0%,97%": { opacity: "1" },
          "98%": { opacity: ".82" },
          "100%": { opacity: "1" },
        },
        scoreroll: {
          from: { transform: "translateY(0.4em)", opacity: "0" },
          to: { transform: "none", opacity: "1" },
        },
        rise: {
          from: { transform: "translateY(8px)", opacity: "0" },
          to: { transform: "none", opacity: "1" },
        },
      },
      animation: {
        blink: "blink 1s step-end infinite",
        flicker: "flicker 4s steps(1) infinite",
        scoreroll: "scoreroll 240ms cubic-bezier(.16,1,.3,1) both",
        rise: "rise 240ms cubic-bezier(.16,1,.3,1) both",
      },
    },
  },
  plugins: [],
};
