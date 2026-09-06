export function isRigolScpiLoggingEnabled(): boolean {
  const value = process.env.RIGOL_SCPI_LOGGING?.trim().toLowerCase();
  return value !== "false" && value !== "0" && value !== "off";
}
