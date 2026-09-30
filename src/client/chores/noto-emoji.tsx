const VARIATION_SELECTOR_16 = 0xfe0f;

export function emojiToCodepoint(emoji: string): string {
  return [...emoji]
    .map((char) => char.codePointAt(0) ?? 0)
    .filter((codePoint) => codePoint !== VARIATION_SELECTOR_16)
    .map((codePoint) => codePoint.toString(16))
    .join("_");
}

const notoModules = import.meta.glob("./noto/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export const NOTO_EMOJI_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(notoModules).map(([path, url]) => {
    const codepoint = path.replace(/^\.\/noto\/emoji_u/, "").replace(/\.svg$/, "");
    return [codepoint, url];
  })
);

interface NotoEmojiProps {
  emoji: string;
  size?: number;
  className?: string;
  urlMap?: Record<string, string>;
}

export function NotoEmoji({ emoji, size, className, urlMap = NOTO_EMOJI_URLS }: NotoEmojiProps) {
  const url = urlMap[emojiToCodepoint(emoji)];
  if (!url) {
    return (
      <span aria-hidden="true" className={className}>
        {emoji}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      aria-hidden="true"
      draggable={false}
      width={size}
      height={size}
      className={className}
    />
  );
}
