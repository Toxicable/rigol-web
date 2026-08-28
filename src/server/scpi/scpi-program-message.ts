export enum ScpiProgramMessageKind {
  Command = 1,
  Query = 2,
}

export function classifyScpiProgramMessage(message: string): ScpiProgramMessageKind {
  validateScpiProgramMessage(message);

  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < message.length; index += 1) {
    const character = message[index];
    if (character === undefined) {
      continue;
    }

    if (quote !== null) {
      if (character === quote) {
        if (message[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    if (character === "?") {
      return ScpiProgramMessageKind.Query;
    }
  }

  return ScpiProgramMessageKind.Command;
}

export function validateScpiProgramMessage(message: string): void {
  if (message.trim().length === 0) {
    throw new Error("Raw SCPI command must not be empty");
  }
  if (message.includes("\n") || message.includes("\r")) {
    throw new Error("Raw SCPI execution accepts exactly one program message");
  }
}
