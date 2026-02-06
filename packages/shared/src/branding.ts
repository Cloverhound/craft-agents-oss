/**
 * Centralized branding assets for Craft Agent
 * Used by OAuth callback pages
 */

/** Cloverhound dog symbol SVG path (viewBox 0 0 376.395 376.395) */
export const CRAFT_SYMBOL_SVG_PATH = 'M235.096,5.982c100.619,25.897,161.215,128.496,135.317,229.114c-25.897,100.619-128.496,161.215-229.114,135.317C40.679,344.516-19.916,241.917,5.982,141.299C31.879,40.68,134.478-19.916,235.096,5.982L235.096,5.982z M194.895,29.643C107.291,26.141,33.406,94.343,29.904,181.947c-3.503,87.605,64.699,161.489,152.303,164.992c70.813,2.832,132.653-41.193,155.611-104.443c-18.047-12.438-60.271,51.142-84.578,68.826c-13.893,10.108-19.646-28.675-9.159-80.099c-21.539,30.881-119.03,43.309-117.398,7.245c-45.297-10.663-35.65-56.595-48.133-57.415c-1.604-3.98-2.127-14.281,4.599-17.09c22.954-9.596,90.781-18.004,138.374-67c2.999-2.404,27.852-14.171,60.589-16.767c12.807-1.015,29.401,7.667,39.972,22.202C295.014,60.398,248.605,31.791,194.895,29.643z';

/** Brand teal color */
export const CRAFT_BRAND_COLOR = '#1FB094';

/** Inline SVG HTML for the Cloverhound symbol logo */
export const CRAFT_LOGO_SVG = `<svg viewBox="0 0 376.395 376.395" width="80" height="80" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" fill="${CRAFT_BRAND_COLOR}" d="${CRAFT_SYMBOL_SVG_PATH}"/></svg>`;

/** Session viewer base URL */
export const VIEWER_URL = 'https://agents.craft.do';
