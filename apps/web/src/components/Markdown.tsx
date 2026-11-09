import { Fragment, type ReactNode } from "react";

type Block = { type: "p" | "ul" | "ol"; lines: string[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBERED = /^\s*\d+[.)]\s+/;

/** Groups consecutive lines into paragraphs and lists, so lists inside a paragraph still render as lists. */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const chunk of text.trim().split(/\n{2,}/)) {
    const lines = chunk.split("\n");
    // A numbered line only starts a list when the whole chunk is numbered; otherwise keep its "2." as text.
    const allNumbered = lines.every((l) => NUMBERED.test(l));
    let current: Block | undefined;
    for (const line of lines) {
      const type: Block["type"] = BULLET.test(line) ? "ul" : allNumbered ? "ol" : "p";
      if (!current || current.type !== type) {
        current = { type, lines: [] };
        blocks.push(current);
      }
      current.lines.push(type === "ul" ? line.replace(BULLET, "") : type === "ol" ? line.replace(NUMBERED, "") : line);
    }
  }
  return blocks;
}

/** Minimal, safe markdown: paragraphs, bullet/numbered lists, **bold** and `code`. No HTML injection. */
export function Markdown({ text }: { text: string }) {
  return (
    <>
      {toBlocks(text).map((block, i) => {
        if (block.type === "ul" || block.type === "ol") {
          const List = block.type;
          return (
            <List key={i}>
              {block.lines.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </List>
          );
        }
        return (
          <p key={i}>
            {block.lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}
