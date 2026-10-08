import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EmojiPicker } from "@/chores/EmojiPicker";
import { LanguageProvider } from "@/i18n";

afterEach(cleanup);

function renderPicker(value: string | null, onChange = vi.fn()) {
  render(
    <LanguageProvider>
      <EmojiPicker value={value} onChange={onChange} />
    </LanguageProvider>
  );
  return onChange;
}

it("searches the curated catalog by label and selects a literal Unicode icon", () => {
  const onChange = renderPicker(null);
  fireEvent.click(screen.getByRole("button", { name: "Select chore icon" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search icons" }), {
    target: { value: "toothbrush" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Select Toothbrush" }));
  expect(onChange).toHaveBeenCalledWith("🪥");
  expect(screen.queryByRole("dialog", { name: "Choose a chore icon" })).toBeNull();
});

it("clears an existing icon to null", () => {
  const onChange = renderPicker("🛏️");
  fireEvent.click(screen.getByRole("button", { name: "Selected icon: 🛏️. Change icon" }));
  fireEvent.click(screen.getByRole("button", { name: "Clear icon" }));
  expect(onChange).toHaveBeenCalledWith(null);
});

it("uses Spanish labels for search and accessibility while preserving keyword aliases and Unicode values", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ locale: { language: "es" } })))
  );
  try {
    const onChange = renderPicker(null);
    fireEvent.click(await screen.findByRole("button", { name: "Seleccionar icono de tarea" }));
    expect(screen.getByRole("heading", { name: "Rutinas diarias" })).toBeInTheDocument();
    const search = screen.getByRole("textbox", { name: "Buscar iconos" });
    fireEvent.change(search, { target: { value: "cepillo de dientes" } });
    expect(screen.getByRole("button", { name: "Seleccionar Cepillo de dientes" })).toHaveAttribute(
      "title",
      "Cepillo de dientes"
    );
    fireEvent.change(search, { target: { value: "wake" } });
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar Alarma" }));
    expect(onChange).toHaveBeenCalledWith("⏰");
  } finally {
    vi.unstubAllGlobals();
  }
});
