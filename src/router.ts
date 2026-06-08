import { createRouter, createWebHashHistory } from 'vue-router';
import ShellWorkbenchView from './views/ShellWorkbenchView.vue';

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'shell-workbench',
      component: ShellWorkbenchView,
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

export default router;
