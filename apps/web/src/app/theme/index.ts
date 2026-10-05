/**
 * @cytale/web — app theme surface.
 *
 * The theme IS the CSS custom properties + Tailwind bridge in tokens.css
 * and shell.css; there is no parallel JS token system (the old
 * ThemeProvider/useTheme path was retired with the last inline-style
 * consumer). Components consume the token utilities (bg-surface,
 * text-text-muted, ...) and shell.css classes only.
 */
export {};
