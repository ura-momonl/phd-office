// Shared by the chat renderer and Windows launcher. Unknown/active formats stay
// in the existing browser preview/download path, never in ShellExecute.
const nativeExtensions=new Set('txt md rst csv tsv json yaml yml toml ini log tex bib pdf doc docx odt rtf xls xlsx ods ppt pptx odp png jpg jpeg gif webp bmp tif tiff avif heic mp3 wav mp4 webm mov opj opju'.split(' '));
export const canOpenInDefaultApp=file=>nativeExtensions.has(file.split('.').pop().toLowerCase());
