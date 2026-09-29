/** Word-search placement uses Math.random as its only randomness source.
 * The caller confines it within withSeededMathRandom, so the same seed produces
 * the same grid. Calls must remain serial because that helper temporarily changes
 * a process-global function. This module does not install or restore the patch.
 */

export interface WordSearchPlacementOptions {
  rows: number;
  cols: number;
  /** Compass keys (N/S/E/W/NE/NW/SE/SW) EXCLUDED from placement, per difficulty profile. */
  disabledDirections: readonly string[];
  /** Candidate words to attempt, in order (already seed-shuffled by the caller). */
  dictionary: readonly string[];
  /** Stop once this many words have been successfully placed. */
  maxWords: number;
  /** Probability (0..1) that a successfully-chosen direction is placed in reverse. */
  backwardsProbability: number;
}

export interface WordSearchPuzzle {
  grid: string[][];
  /** The words actually placed (uppercased), in placement order — may be fewer than `maxWords`. */
  words: string[];
}

const DIRECTIONS: Record<string, readonly [number, number]> = {
  N: [-1, 0],
  S: [1, 0],
  E: [0, 1],
  W: [0, -1],
  NE: [-1, 1],
  NW: [-1, -1],
  SE: [1, 1],
  SW: [1, -1],
};

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_ATTEMPTS_PER_WORD = 50;

function fits(
  grid: ReadonlyArray<ReadonlyArray<string | null>>,
  word: string,
  row: number,
  col: number,
  dRow: number,
  dCol: number,
  rows: number,
  cols: number
): boolean {
  for (let i = 0; i < word.length; i += 1) {
    const r = row + dRow * i;
    const c = col + dCol * i;
    if (r < 0 || r >= rows || c < 0 || c >= cols) return false;
    const existing = grid[r][c];
    if (existing !== null && existing !== word[i]) return false;
  }
  return true;
}

function place(
  grid: Array<Array<string | null>>,
  word: string,
  row: number,
  col: number,
  dRow: number,
  dCol: number
): void {
  for (let i = 0; i < word.length; i += 1) {
    grid[row + dRow * i][col + dCol * i] = word[i];
  }
}

/** Builds a `rows x cols` word-search grid: attempts to place each dictionary word (in order) at a
 * random position/direction (retrying up to a bounded attempt count per word before skipping it),
 * then fills every remaining empty cell with a random uppercase letter. Every random draw goes
 * through the global `Math.random` — the caller confines it via `withSeededMathRandom` for
 * determinism (see the module doc comment).
 */
export function buildWordSearchPuzzle(options: WordSearchPlacementOptions): WordSearchPuzzle {
  const { rows, cols, dictionary, maxWords, backwardsProbability } = options;
  const allowedDirectionKeys = Object.keys(DIRECTIONS).filter(
    (key) => !options.disabledDirections.includes(key)
  );
  if (allowedDirectionKeys.length === 0) {
    throw new Error(
      "daily-briefing wordSearch: no directions available after disabling — check the profile"
    );
  }

  const grid: Array<Array<string | null>> = Array.from({ length: rows }, () =>
    new Array<string | null>(cols).fill(null)
  );
  const placedWords: string[] = [];

  for (const rawWord of dictionary) {
    if (placedWords.length >= maxWords) break;
    const word = rawWord.toUpperCase();
    if (word.length === 0 || word.length > Math.max(rows, cols)) continue;

    for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_WORD; attempt += 1) {
      const directionKey =
        allowedDirectionKeys[Math.floor(Math.random() * allowedDirectionKeys.length)];
      const [baseDRow, baseDCol] = DIRECTIONS[directionKey];
      const backwards = Math.random() < backwardsProbability;
      const dRow = backwards ? -baseDRow : baseDRow;
      const dCol = backwards ? -baseDCol : baseDCol;
      const row = Math.floor(Math.random() * rows);
      const col = Math.floor(Math.random() * cols);

      if (fits(grid, word, row, col, dRow, dCol, rows, cols)) {
        place(grid, word, row, col, dRow, dCol);
        placedWords.push(word);
        break;
      }
    }
  }

  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (grid[r][c] === null) {
        grid[r][c] = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      }
    }
  }

  return {
    grid: grid as string[][],
    words: placedWords,
  };
}
