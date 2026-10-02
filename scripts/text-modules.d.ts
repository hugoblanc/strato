/**
 * Files imported as text (`import x from "./file.md" with { type: "text" }`): Bun inlines them, and
 * `bun build --compile` embeds them in the binary, which has no file next to its code.
 */
declare module "*.md" {
  const text: string;
  export default text;
}
declare module "*.zsh" {
  const text: string;
  export default text;
}
declare module "*.txt" {
  const text: string;
  export default text;
}
