export type IpcSenderDetails = {
  sender: unknown;
  senderFrame?: { url?: string } | null;
};

export type TrustedWindowDetails = {
  webContents: { mainFrame: unknown };
};

export function assertTrustedIpcSender(
  event: IpcSenderDetails,
  mainWindow: TrustedWindowDetails | null | undefined,
  isTrustedRendererUrl: (url: string) => boolean,
): void {
  const frameUrl = event.senderFrame?.url;
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !frameUrl ||
    !isTrustedRendererUrl(frameUrl)
  )
    throw new Error("Origem da solicitação não autorizada.");
}
