/** @type {import('tailwindcss').Config} */
export default {
  // NOTE: corrected from "./src/*/.jsx" (which matches nothing) to a glob that
  // actually catches the components, so classes are not purged.
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
