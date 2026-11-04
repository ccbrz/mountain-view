import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App as AntApp, ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import './styles/global.css'
import { appTheme } from './theme'
import App from './App'

// Static message / Modal.confirm calls render outside the React tree; give them the same theme.
ConfigProvider.config({
  holderRender: children => (
    <ConfigProvider locale={zhCN} theme={appTheme}>
      {children}
    </ConfigProvider>
  ),
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={appTheme}>
      <AntApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
)
