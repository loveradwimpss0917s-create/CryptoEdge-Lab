/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // docs/06 §6: verdict semantics — color plus text label always, never color alone.
        adopt: "#22c55e",
        watch: "#f59e0b",
        reject: "#ef4444",
        decaying: "#fb923c",
        reference: "#9ca3af"
      }
    }
  },
  plugins: []
};
