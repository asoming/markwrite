declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: (service: TurndownService) => void;
}
declare module 'mammoth/mammoth.browser' {
  import mammoth = require('mammoth');
  export default mammoth;
}
