/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    text: '#0B1220',
    tint: '#0FA6A0',
    background: '#F4F8FA',
    foreground: '#0B1220',
    card: '#FFFFFF',
    cardForeground: '#0B1220',
    primary: '#0FA6A0',
    primaryForeground: '#FFFFFF',
    secondary: '#E3F2F1',
    secondaryForeground: '#0B5C5A',
    muted: '#EAF0F3',
    mutedForeground: '#6B7B88',
    accent: '#FF765D',
    accentForeground: '#FFFFFF',
    destructive: '#D84C4C',
    destructiveForeground: '#FFFFFF',
    border: '#D9E4E9',
    input: '#D9E4E9',
  },
  dark: {
    text: '#F4F8FA',
    tint: '#42D4C8',
    background: '#07151F',
    foreground: '#F4F8FA',
    card: '#102733',
    cardForeground: '#F4F8FA',
    primary: '#42D4C8',
    primaryForeground: '#07151F',
    secondary: '#173C43',
    secondaryForeground: '#B5F6EF',
    muted: '#18313E',
    mutedForeground: '#91A7B3',
    accent: '#FF8069',
    accentForeground: '#07151F',
    destructive: '#FF7B7B',
    destructiveForeground: '#07151F',
    border: '#244451',
    input: '#244451',
  },
  radius: 8,
};

export default colors;
