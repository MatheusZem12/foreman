import plugin from 'tailwindcss/plugin';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        panel: 'rgb(var(--panel) / <alpha-value>)',
        card: 'rgb(var(--card) / <alpha-value>)',
        hover: 'rgb(var(--hover) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        dim: 'rgb(var(--dim) / <alpha-value>)',
        mute: 'rgb(var(--mute) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        // "white/x" is the overlay ink: white in the dark theme, black in the
        // light one. Real white (text on top of the purple) is "snow".
        white: 'rgb(var(--ink) / <alpha-value>)',
        snow: '#ffffff'
      },
      boxShadow: {
        pop: '0 16px 48px -12px rgb(0 0 0 / var(--shadow, 0.5)), 0 2px 6px -2px rgb(0 0 0 / calc(var(--shadow, 0.5) / 2))'
      },

      fontFamily: {
        sans: ['Inter Variable', 'Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono Variable', 'JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace']
      }
    }
  },
  // hover: only where there is a real hover (no "stuck" hover after a tap on phones).
  future: { hoverOnlyWhenSupported: true },
  // coarse: = a finger instead of a mouse, for touch targets that need to grow.
  plugins: [plugin(({ addVariant }) => addVariant('coarse', '@media (pointer: coarse)'))]
};
