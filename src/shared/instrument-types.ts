export enum SupportedInstrument {
  Dho804 = 1,
  Dm858e = 2,
  Ppk2 = 3,
}

export type ScpiInstrument =
  | SupportedInstrument.Dho804
  | SupportedInstrument.Dm858e;
