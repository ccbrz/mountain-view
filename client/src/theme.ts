import { theme, type ThemeConfig } from 'antd'

/** One dark, literary palette for the whole app. Keep in sync with the CSS variables in styles/global.css. */
export const palette = {
  bg: '#121317',
  surface: '#17191e',
  raised: '#1d2026',
  elevated: '#22252c',
  line: 'rgba(255,255,255,0.07)',
  lineStrong: 'rgba(255,255,255,0.12)',
  text: '#ece7dd',
  textSecondary: '#b4afa5',
  muted: '#8a8f99',
  gold: '#d6b97c',
  goldStrong: '#e9d09b',
  sage: '#93a98d',
  amber: '#d9a85c',
  danger: '#d47b6f',
}

export const fontSans = 'Inter, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif'
export const fontSerif = '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", SimSun, serif'

export const appTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: palette.gold,
    colorInfo: palette.gold,
    colorSuccess: palette.sage,
    colorWarning: palette.amber,
    colorError: palette.danger,
    colorBgBase: palette.bg,
    colorBgLayout: palette.bg,
    colorBgContainer: palette.surface,
    colorBgElevated: palette.elevated,
    colorBorder: palette.lineStrong,
    colorBorderSecondary: palette.line,
    colorTextBase: palette.text,
    colorTextSecondary: palette.textSecondary,
    colorTextTertiary: palette.muted,
    fontFamily: fontSans,
    fontSize: 14,
    borderRadius: 8,
    borderRadiusLG: 12,
    controlHeight: 34,
    wireframe: false,
  },
  components: {
    Button: { primaryColor: '#1d1810', fontWeight: 500, defaultBg: 'transparent' },
    Card: { colorBgContainer: palette.surface },
    Modal: { contentBg: palette.raised, headerBg: palette.raised, titleFontSize: 17 },
    Drawer: { colorBgElevated: palette.surface },
    Layout: { bodyBg: palette.bg, siderBg: '#0f1013', headerBg: palette.bg },
    Menu: {
      darkItemBg: '#0f1013',
      darkItemSelectedBg: 'rgba(214,185,124,0.12)',
      darkItemSelectedColor: palette.goldStrong,
    },
    Table: { headerBg: palette.raised, rowHoverBg: 'rgba(255,255,255,0.02)' },
    Tabs: { itemSelectedColor: palette.goldStrong, inkBarColor: palette.gold, itemColor: palette.muted },
    Tag: { defaultBg: 'rgba(255,255,255,0.04)' },
    Input: { activeShadow: '0 0 0 2px rgba(214,185,124,0.12)' },
  },
}
