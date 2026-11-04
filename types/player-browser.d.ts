export type FusionFileHandle = {
  kind: "file";
  name: string;
  getFile(): Promise<File>;
};

export type FusionDirectoryHandle = {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<FusionFileHandle | FusionDirectoryHandle>;
  queryPermission(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission(options: { mode: "read" }): Promise<PermissionState>;
};

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FusionDirectoryHandle>;
  }

  interface HTMLMediaElement {
    setSinkId?: (sinkId: string) => Promise<void>;
  }

  interface MediaDevices {
    selectAudioOutput?: () => Promise<MediaDeviceInfo>;
  }
}

export {};
