/**
 * Bauhaus primary palette — red, yellow, blue on white.
 *
 * Blue  (#1A5FFF / #4D80FF dark) — primary actions, speed zones, active state
 * Yellow (#FFD600)               — power zones, success/rest-complete, highlights
 * Red   (#E8001D / #FF2D3B dark) — recording, maximal strength, errors, fatigued reps
 * White (#FFFFFF)                — background canvas
 */

const colors = {
  light: {
    text: '#0A0A0A',
    tint: '#1A5FFF',
    background: '#FFFFFF',
    foreground: '#0A0A0A',
    card: '#FFFFFF',
    cardForeground: '#0A0A0A',
    primary: '#1A5FFF',
    primaryForeground: '#FFFFFF',
    secondary: '#F0F4FF',
    secondaryForeground: '#1A3A8A',
    muted: '#F5F5F5',
    mutedForeground: '#767676',
    accent: '#FFD600',
    accentForeground: '#0A0A0A',
    destructive: '#E8001D',
    destructiveForeground: '#FFFFFF',
    border: '#E5E5E5',
    input: '#E5E5E5',
  },
  dark: {
    text: '#FFFFFF',
    tint: '#4D80FF',
    background: '#0A0A10',
    foreground: '#FFFFFF',
    card: '#141420',
    cardForeground: '#FFFFFF',
    primary: '#4D80FF',
    primaryForeground: '#FFFFFF',
    secondary: '#1A1A2C',
    secondaryForeground: '#4D80FF',
    muted: '#1E1E2E',
    mutedForeground: '#8888A0',
    accent: '#FFD600',
    accentForeground: '#0A0A10',
    destructive: '#FF2D3B',
    destructiveForeground: '#FFFFFF',
    border: '#2A2A3E',
    input: '#2A2A3E',
  },
  radius: 8,
};

export default colors;
