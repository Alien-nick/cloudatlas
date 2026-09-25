import { createApp } from 'vue'
import { createPinia } from 'pinia'

import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import './style.css'

import App from './App.vue'

createApp(App).use(createPinia()).mount('#app')
