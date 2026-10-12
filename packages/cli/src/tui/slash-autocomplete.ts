import { TUI_COMMANDS } from "./runtime-input.js";

export function buildSlashCommands(language: "zh" | "en" = "zh"): readonly string[] {
  return TUI_COMMANDS.map(command => command.startsWith("/new ")
    ? (language === "en" ? "/new conversation instructions" : "/new 会话说明")
    : command);
}

export const SLASH_COMMANDS = buildSlashCommands("zh");

export type SlashNavigationDirection = "up" | "down";

export function getSlashSuggestions(input: string, commands: readonly string[]): string[] {
  const value = input.trim();
  if (!value.startsWith("/")) {
    return [];
  }

  return commands.filter((command) => slashCommandStem(command).startsWith(value));
}

export function getNextSlashSelection(
  currentIndex: number,
  suggestionCount: number,
  direction: SlashNavigationDirection,
): number {
  if (suggestionCount <= 0) {
    return 0;
  }

  if (direction === "down") {
    return (currentIndex + 1) % suggestionCount;
  }

  return (currentIndex - 1 + suggestionCount) % suggestionCount;
}

export function applySlashSuggestion(
  _input: string,
  suggestions: readonly string[],
  selectedIndex: number,
): string {
  const suggestion = suggestions[selectedIndex] ?? "";
  return slashSuggestionInsertion(suggestion);
}

function slashCommandStem(command: string): string {
  return command.match(/^\/\S+/)?.[0] ?? command;
}

function slashSuggestionInsertion(suggestion: string): string {
  const stem = slashCommandStem(suggestion);
  return suggestion === stem ? stem : `${stem} `;
}
