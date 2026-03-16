interface Config {
  download: {
    path: string;
    videoFileNamePattern: string;
    showDownloadGuidance: boolean;
    videoQuality: number;
    videoCodec: string;
    audioQuality: number;
    danmaku: boolean;
  };
  proxy: {
    enable: boolean;
    useSystemProxy: boolean;
    url: string;
  };
  cookieString: string;
  update: {
    autoCheck: boolean;
  };
}

export default Config;
