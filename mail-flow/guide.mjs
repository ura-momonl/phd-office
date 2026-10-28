import fs from 'node:fs';

// Full send/reply mechanics: optional CLI reading (`mail guide`) and `outlook-prepare.guidance`.
export const mailGuide = () => fs.readFileSync(new URL('./INTERACTIVE-GUIDE.md', import.meta.url), 'utf8').trim();
// Short work goal, material entry points and authorization floor: the only mail text injected into interactive mail prompts.
export const mailBrief = () => fs.readFileSync(new URL('./MAIL-BRIEF.md', import.meta.url), 'utf8').trim();
