import BilibiliVideo from '../../types/models/BilibiliVideo';
import { getAxiosInstance, cookieJar } from '../network';
import IService from './IService';
import crypto from 'crypto';
import GeetestCaptcha from '../../types/models/GeetestCaptcha';
import configService from './config-service';

// WBI 签名机制（参考：https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/misc/sign/wbi.md）
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

let wbiKeyCache: { mixinKey: string; day: number } | null = null;

async function getWbiMixinKey(): Promise<string> {
  const today = Math.floor(Date.now() / 86400000);
  if (wbiKeyCache && wbiKeyCache.day === today) {
    return wbiKeyCache.mixinKey;
  }

  const axios = await getAxiosInstance();
  const nav: any = (
    await axios('https://api.bilibili.com/x/web-interface/nav')
  ).data;
  const imgKey: string = nav.data.wbi_img.img_url
    .split('/')
    .pop()
    .replace(/\.\w+$/, '');
  const subKey: string = nav.data.wbi_img.sub_url
    .split('/')
    .pop()
    .replace(/\.\w+$/, '');
  const rawWbiKey = imgKey + subKey;
  const mixinKey = MIXIN_KEY_ENC_TAB.map((i) => rawWbiKey[i])
    .join('')
    .slice(0, 32);

  wbiKeyCache = { mixinKey, day: today };
  return mixinKey;
}

async function signWbi(params: Record<string, any>): Promise<Record<string, any>> {
  const mixinKey = await getWbiMixinKey();
  const wts = Math.floor(Date.now() / 1000);
  const signed: Record<string, any> = { ...params, wts };
  const query = Object.keys(signed)
    .sort()
    .map((key) => {
      const val = String(signed[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(val)}`;
    })
    .join('&');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return { ...signed, w_rid: wRid };
}

async function getCSRF() {
  const config = await configService.fns.getAll();
  const tmp = `; ${config.cookieString}`.split('; bili_jct=').pop();

  if (!tmp) return '';
  return tmp.split('; ').shift();
}

const fns = {
  async getVideoInfo(bvid: string): Promise<any> {
    const axios = await getAxiosInstance();
    return (
      await axios.get('https://api.bilibili.com/x/web-interface/wbi/view', {
        params: await signWbi({ bvid }),
      })
    ).data as any;
  },

  async getVideoPlayUrl(bvid: string, cid: string): Promise<any> {
    const axios = await getAxiosInstance();
    return (
      await axios.get('https://api.bilibili.com/x/player/wbi/playurl', {
        params: await signWbi({
          cid,
          bvid,
          fourk: 1,
          otype: 'json',
          fnver: 0,
          fnval: 4048,
        }),
      })
    ).data;
  },

  async getSelfInfo(): Promise<any> {
    const axios = await getAxiosInstance();
    return (await axios('https://api.bilibili.com/x/space/myinfo')).data;
  },

  async getCaptchaSettings(): Promise<any> {
    const axios = await getAxiosInstance();
    return (
      await axios('https://passport.bilibili.com/x/passport-login/captcha')
    ).data;
  },

  /**
   * 使用密码登录，不报错视为登录成功，会自动更新配置。
   * @param username
   * @param password
   * @param captcha
   */
  async loginWithPassword(
    username: string,
    password: string,
    captcha: GeetestCaptcha
  ): Promise<void> {
    const axios = await getAxiosInstance();

    // 获取加密配置
    const encryptionSettings: any = (
      await axios('https://passport.bilibili.com/x/passport-login/web/key')
    ).data;

    if (encryptionSettings.code !== 0)
      throw new Error(`获取加密配置错误：${encryptionSettings.message}`);

    // 加密密码
    const encryptedPassword = crypto
      .publicEncrypt(
        {
          key: crypto.createPublicKey(encryptionSettings.data.key),
          padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        Buffer.from(`${encryptionSettings.data.hash}${password}`, 'utf-8')
      )
      .toString('base64');

    const loginResult = await axios.post(
      'https://passport.bilibili.com/x/passport-login/web/login',
      new URLSearchParams({
        source: 'main_web',
        username,
        password: encryptedPassword,
        keep: 'true',
        token: captcha.token,
        go_url: 'https://www.bilibili.com/',
        challenge: captcha.challenge,
        validate: captcha.validate,
        seccode: captcha.seccode,
      }).toString(),
      {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
        },
      }
    );

    if (loginResult.data.code !== 0) return loginResult.data;

    // 更新配置
    configService.fns.set(
      'cookieString',
      await cookieJar.getCookieString('https://www.bilibili.com/')
    );

    return loginResult.data;
  },

  async getLoginQrCode() {
    const axios = await getAxiosInstance();
    return (
      await axios(
        'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
      )
    ).data;
  },

  async getLoginQrCodeStatus(qrcodeKey: string) {
    const axios = await getAxiosInstance();
    const resp: any = (
      await axios(
        'https://passport.bilibili.com/x/passport-login/web/qrcode/poll',
        {
          params: {
            qrcode_key: qrcodeKey,
          },
        }
      )
    ).data;

    if (resp.data?.code === 0) {
      // 登录成功，更新配置
      configService.fns.set(
        'cookieString',
        await cookieJar.getCookieString('https://www.bilibili.com/')
      );
    }

    return resp;
  },

  async logOut() {
    await cookieJar.removeAllCookies();
    configService.fns.set('cookieString', '');
  },

  async sendSms(cid: string, phoneNumber: string, captcha: GeetestCaptcha) {
    const axios = await getAxiosInstance();
    return (
      await axios.post(
        'https://passport.bilibili.com/x/passport-login/web/sms/send',
        new URLSearchParams({
          cid,
          tel: phoneNumber,
          source: 'main_mini',
          ...captcha,
        }).toString(),
        {
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
          },
        }
      )
    ).data;
  },

  async loginWithSmsCode(
    cid: string,
    phoneNumber: string,
    code: string,
    captchaKey: string
  ) {
    const axios = await getAxiosInstance();
    const resp: any = (
      await axios.post(
        'https://passport.bilibili.com/x/passport-login/web/login/sms',
        new URLSearchParams({
          cid,
          tel: phoneNumber,
          code,
          source: 'main_mini',
          keep: '0',
          captcha_key: captchaKey,
          go_url: 'https://www.bilibili.com/',
        }).toString()
      )
    ).data;

    if (resp.code === 0) {
      // 登录成功，更新配置
      configService.fns.set(
        'cookieString',
        await cookieJar.getCookieString('https://www.bilibili.com/')
      );
    }

    return resp;
  },

  async loginWithCookie(cookieString: string): Promise<boolean> {
    try {
      cookieString
        .split(';')
        .filter((cookie) => !!cookie.trim())
        .forEach((cookie) =>
          cookieJar.setCookieSync(
            `${cookie}; Domain=.bilibili.com`,
            'https://www.bilibili.com/'
          )
        );
    } catch (err) {
      return false;
    }

    const resp = await bilibiliService.fns.getSelfInfo();

    if (resp.code === 0) {
      // 登录成功，更新配置
      configService.fns.set(
        'cookieString',
        await cookieJar.getCookieString('https://www.bilibili.com/')
      );
    }

    return resp.code === 0;
  },

  async getBangumiInfoByMediaId(mediaId: number): Promise<any> {
    const url = 'https://api.bilibili.com/pgc/review/user';
    const axios = await getAxiosInstance();

    // 获取对应的 season_id
    const resp = await axios(url, {
      params: {
        media_id: mediaId,
      },
    });

    if (resp.data.code !== 0) throw new Error(`请求错误：${resp.data.message}`);

    const seasonId = resp.data.result.media.season_id;

    return fns.getBangumiInfoBySeasonId(seasonId);
  },

  async getBangumiInfoBySeasonId(seasonId: number): Promise<any> {
    const url = 'https://api.bilibili.com/pgc/view/web/season';
    const axios = await getAxiosInstance();
    return (
      await axios(url, {
        params: {
          season_id: seasonId,
        },
      })
    ).data;
  },

  async getBangumiInfoByEpisodeId(episodeId: number): Promise<any> {
    const url = 'https://api.bilibili.com/pgc/view/web/season';
    const axios = await getAxiosInstance();
    return (
      await axios(url, {
        params: {
          ep_id: episodeId,
        },
      })
    ).data;
  },

  async getBangumiPlayUrl(epId: number, cid: number): Promise<any> {
    const axios = await getAxiosInstance();
    return (
      await axios('https://api.bilibili.com/pgc/player/web/playurl', {
        params: {
          ep_id: epId,
          cid,
          fourk: 1,
          fnver: 0,
          fnval: 4048,
        },
      })
    ).data;
  },
};

const bilibiliService: IService<typeof fns> = {
  name: 'bilibili',
  fns,
};

export default bilibiliService;
