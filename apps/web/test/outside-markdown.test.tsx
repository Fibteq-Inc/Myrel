import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutsideMarkdown } from "../src/components/chat/markdown";

/** Text from outside the project, as the Issues tab draws it. */
const draw = (body: string) => renderToStaticMarkup(<OutsideMarkdown body={body} />);

describe("OutsideMarkdown", () => {
  it("does not load images, only links to them", () => {
    const html = draw("![shot](https://example.com/pixel.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/pixel.png"');
    expect(html).toContain("shot");
  });

  it("opens web links but nothing of the project", () => {
    const html = draw("[web](https://example.com) [file](secrets/notes.md) [thread](#thr_123) [script](javascript:alert(1))");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noreferrer nofollow"');
    expect(html.match(/<a /g)).toHaveLength(1);
    for (const text of ["secrets/notes.md", "#thr_123", "javascript:"]) expect(html).not.toContain(text);
  });

  it("draws a decision block as code, not a card, and raw HTML as text", () => {
    const html = draw('```decision\n{"question":"Pwn?","options":[{"label":"Yes"},{"label":"No"}]}\n```\n\n<b>raw</b>');
    expect(html).toContain("Pwn?");
    expect(html).not.toContain(">Yes</button>");
    expect(html).not.toContain("<b>");
  });
});
