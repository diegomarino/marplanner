import { Fragment, useMemo, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Elements whose text must not leak into the page once the element itself is dropped. */
const DROPPED_WITH_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "template",
  "noscript",
  "head",
  "title",
  "svg",
  "math",
]);
const HTML_TAG = /<[a-z][\s\S]*>/i;
const BARE_URL = /(https?:\/\/[^\s<>"']+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

function safeHref(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function link(href: string, children: ReactNode, key: string): ReactNode {
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary break-all underline underline-offset-2"
    >
      {children}
    </a>
  );
}

/** Plain text with any bare web address turned into a link. */
function linkify(text: string, key: string): ReactNode[] {
  return text.split(BARE_URL).map((part, index) => {
    if (index % 2 === 0) return part;
    const trailing = TRAILING_PUNCTUATION.exec(part)?.[0] ?? "";
    const address = trailing ? part.slice(0, -trailing.length) : part;
    const href = safeHref(address);
    if (!href) return part;
    return (
      <Fragment key={`${key}.${index}`}>
        {link(href, address, "a")}
        {trailing}
      </Fragment>
    );
  });
}

/** Rebuilds one parsed node as React elements. Only the tags named here survive; every other
 * element is replaced by its children, and no attribute is copied except a checked `href`.
 */
function renderNode(node: ChildNode, key: string, insideLink: boolean): ReactNode {
  if (node.nodeType === 3) {
    const text = node.textContent ?? "";
    return insideLink ? text : <Fragment key={key}>{linkify(text, key)}</Fragment>;
  }
  if (node.nodeType !== 1) return null;

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (DROPPED_WITH_CONTENT.has(tag)) return null;

  const href = tag === "a" ? safeHref(element.getAttribute("href")) : null;
  const children = Array.from(element.childNodes).map((child, index) =>
    renderNode(child, `${key}.${index}`, insideLink || href !== null)
  );

  switch (tag) {
    case "br":
      return <br key={key} />;
    case "b":
    case "strong":
      return <strong key={key}>{children}</strong>;
    case "i":
    case "em":
      return <em key={key}>{children}</em>;
    case "u":
      return <u key={key}>{children}</u>;
    case "p":
      return <p key={key}>{children}</p>;
    case "ul":
      return (
        <ul key={key} className="list-disc pl-5">
          {children}
        </ul>
      );
    case "ol":
      return (
        <ol key={key} className="list-decimal pl-5">
          {children}
        </ol>
      );
    case "li":
      return <li key={key}>{children}</li>;
    case "a":
      return href ? link(href, children, key) : <Fragment key={key}>{children}</Fragment>;
    default:
      return <Fragment key={key}>{children}</Fragment>;
  }
}

/** An event description as its author or an external feed wrote it: plain text keeps its line
 * breaks, and basic HTML (emphasis, paragraphs, lists, links) is rebuilt from an allowlist.
 * Nothing from the source is injected as markup, so scripts, styles, event handlers and
 * non-web link targets cannot reach the page.
 */
export function EventDescription({ text, className }: { text: string; className?: string }) {
  const content = useMemo<ReactNode>(() => {
    if (!HTML_TAG.test(text)) return linkify(text, "text");
    const parsed = new DOMParser().parseFromString(text, "text/html");
    return Array.from(parsed.body.childNodes).map((node, index) =>
      renderNode(node, `node.${index}`, false)
    );
  }, [text]);

  return (
    <div className={cn("break-words whitespace-pre-line [&_p+p]:mt-2", className)}>{content}</div>
  );
}
