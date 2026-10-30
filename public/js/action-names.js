import { t } from './i18n.js';

/* Человекочитаемые названия действий журнала (общие для журнала, профиля и истории сервиса). */
export const ACTION_NAMES = { 'service.deploy': 'Деплой', 'service.restart': 'Перезапуск', 'service.start': 'Запуск', 'service.stop': 'Остановка', 'service.destroy': 'Удаление сервиса', 'service.create': 'Создание сервиса', 'service.env': 'Правка env', 'project.create': 'Создание проекта', 'project.destroy': 'Удаление проекта', 'panel.add': 'Панель добавлена', 'panel.update': 'Панель изменена', 'panel.remove': 'Панель удалена', 'service.clone': 'Клонирование', 'service.sourceImage': 'Смена образа', 'system.prune': 'Docker prune', 'system.cleanupImages': 'Очистка образов', 'bulk.env': 'Массово: env', 'bulk.image': 'Массово: образ', 'template.save': 'Шаблон сохранён', 'hook.create': 'Вебхук создан', 'hook.deploy': 'Деплой по вебхуку', 'backup.download': 'Скачан бэкап', 'user.2fa_on': '2FA включена', 'user.2fa_off': '2FA отключена', 'channel.add': 'Канал уведомлений', 'cert.reissue': 'Перевыпуск сертификата', 'cert.delete': 'Удаление сертификата', 'settings.timezone': 'Часовой пояс сервера', 'profile.update': 'Профиль изменён', 'session.revoke': 'Сессия завершена', 'session.revoke_others': 'Остальные сессии завершены', 'user.create': 'Пользователь создан', 'user.update': 'Пользователь изменён', 'user.delete': 'Пользователь удалён', 'user.sessions_revoked': 'Сессии пользователя завершены', 'user.password_changed': 'Пароль изменён', login: 'Вход', 'login.sso': 'Вход через SSO' };
const OP_NAMES = { env: 'Правка env', resources: 'Изменение ресурсов', sourceImage: 'Смена образа', sourceGithub: 'Смена источника (GitHub)', sourceGit: 'Смена источника (Git)', domainAdd: 'Домен добавлен', domainUpdate: 'Домен изменён', domainDelete: 'Домен удалён', domainPrimary: 'Основной домен изменён', sshKey: 'SSH-ключ сервиса',
  portAdd: 'Порт открыт', portUpdate: 'Порт изменён', portDelete: 'Порт удалён', mountAdd: 'Монтирование добавлено', mountUpdate: 'Монтирование изменено', mountDelete: 'Монтирование удалено', notes: 'Заметки изменены' };
const PSET_TITLES = { panelDomain: 'Домен панели', serviceDomain: 'Базовый домен сервисов', letsEncryptEmail: 'E-mail Let’s Encrypt', telemetry: 'Телеметрия', dailyCleanup: 'Ночная очистка Docker', googleAnalytics: 'Google Analytics', githubToken: 'Токен GitHub',
  brandingBasic: 'Название и цвет сервера', brandingLinks: 'Ссылки в интерфейсе', errorPages: 'Страницы ошибок', customCode: 'Свой код в интерфейсе', metrics: 'Расширенные метрики', logsAgg: 'Сбор логов' };
const ACTION_NAMES_EXTRA = {
  'file.write': 'Файл сохранён', 'file.mkdir': 'Папка создана', 'file.touch': 'Файл создан', 'file.rename': 'Файл переименован', 'file.chmod': 'Права файла изменены', 'file.delete': 'Файл удалён', 'file.download': 'Файл скачан', 'file.upload': 'Файл загружен',
  'panel.user.create': 'Пользователь Easypanel создан', 'panel.user.update': 'Пользователь Easypanel изменён', 'panel.user.destroy': 'Пользователь Easypanel удалён', 'panel.user.token.generate': 'API-токен пользователя выдан', 'panel.user.token.revoke': 'API-токен пользователя отозван',
  'panel.account.credentials': 'Смена e-mail и пароля аккаунта', 'panel.2fa.configure': '2FA: настройка', 'panel.2fa.enable': '2FA в панели включена', 'panel.2fa.disable': '2FA в панели отключена',
  'panel.notify.create': 'Канал уведомлений панели создан', 'panel.notify.update': 'Канал уведомлений панели изменён', 'panel.notify.destroy': 'Канал уведомлений панели удалён', 'panel.notify.test': 'Тест уведомления панели', 'panel.action.kill': 'Действие панели остановлено',
  'storage.provider.create': 'Хранилище бэкапов создано', 'storage.provider.update': 'Хранилище бэкапов изменено', 'storage.provider.delete': 'Хранилище бэкапов удалено',
  'backup.db.create': 'Расписание бэкапа базы создано', 'backup.db.update': 'Расписание бэкапа базы изменено', 'backup.db.delete': 'Расписание бэкапа базы удалено', 'backup.db.run': 'Бэкап базы запущен', 'backup.db.restore': 'База восстановлена из бэкапа',
  'backup.volume.create': 'Расписание бэкапа тома создано', 'backup.volume.update': 'Расписание бэкапа тома изменено', 'backup.volume.delete': 'Расписание бэкапа тома удалено', 'backup.volume.run': 'Бэкап тома запущен',
  'builder.create': 'Билдер Docker создан', 'builder.use': 'Билдер Docker выбран', 'builder.stop': 'Билдер Docker остановлен', 'builder.remove': 'Билдер Docker удалён',
  'traefik.config.set': 'Traefik: конфигурация изменена', 'traefik.env.set': 'Traefik: переменные окружения изменены', 'branding.logo': 'Логотип интерфейса панели', 'cluster.node.remove': 'Узел кластера удалён',
  'license.lemon.activate': 'Лицензия активирована (ключ)', 'license.lemon.order': 'Лицензия активирована (заказ)', 'license.portal.activate': 'Лицензия активирована (Portal)', 'license.lemon.deactivate': 'Лицензия Lemon деактивирована', 'license.portal.deactivate': 'Лицензия Portal деактивирована',
  'docker.update.start': 'Обновление Docker запущено', 'panel.install.check': 'Проверка сервера для установки', 'panel.install.start': 'Установка Easypanel запущена', 'panel.install.done': 'Easypanel установлена', 'panel.install.failed': 'Установка Easypanel не удалась',
  'system.cleanupBuilder': 'Очистка кэша сборки', 'system.refreshServerIp': 'Обновление IP сервера', 'system.restartTraefik': 'Перезапуск Traefik', 'system.updatePanel': 'Обновление Easypanel', 'system.restartPanel': 'Перезапуск Easypanel', 'system.reboot': 'Перезагрузка сервера',
  'backup.service': 'Копия данных сервиса', 'backup.restore_data': 'Восстановление данных запущено', 'backup.restore_data_done': 'Восстановление данных завершено', 'backup.data_run': 'Копирование данных запущено', 'backup.data_done': 'Копирование данных завершено', 'backup.panel_failed': 'Копирование данных панели не удалось',
  'backup.run': 'Копия настроек EasyAdmin создана', 'backup.settings': 'Настройки копирования изменены', 'backup.delete': 'Копия удалена', 'backup.restore': 'EasyAdmin восстановлен из копии', 'backup.restore_service': 'Сервис восстановлен из копии', 'backup.panel_config': 'Конфигурация панели прочитана из копии',
  'template.update': 'Шаблон изменён', 'builder.update': 'Билдер Docker пересоздан', 'service.sshKey': 'SSH-ключ сервиса создан',
  'console.open': 'Консоль открыта', 'console.close': 'Консоль закрыта',
  'status.settings': 'Настройки Status Page изменены', 'status.incident.create': 'Инцидент создан', 'status.incident.update': 'Инцидент изменён', 'status.incident.delete': 'Инцидент удалён',
};
/** Человекочитаемое название действия из журнала (service.*, bulk.*, schedule.* и т. д.). */
export function actionLabel(action) {
  if (ACTION_NAMES[action]) return ACTION_NAMES[action];
  if (ACTION_NAMES_EXTRA[action]) return ACTION_NAMES_EXTRA[action];
  if (String(action).startsWith('psettings.')) { const k = String(action).slice(10); return `${t('Настройка панели')}: ${t(PSET_TITLES[k] ?? k)}`; }
  const [ns, rest] = String(action).split('.');
  if (ns === 'service' && OP_NAMES[rest]) return OP_NAMES[rest];
  if (ns === 'bulk') return `Массово: ${actionLabel(`service.${rest}`)}`;
  if (ns === 'schedule') return rest === 'add' ? 'Расписание создано' : `Расписание: ${actionLabel(`service.${rest}`)}`;
  return action;
}

/** Подробности записи журнала в читаемом виде: JSON настроек копирования — словами, остальное как есть. */
export function detailLabel(action, detail) {
  if (!detail) return detail;
  if (action === 'backup.settings') {
    try {
      const d = JSON.parse(detail); const parts = [d.enabled ? 'расписание включено' : 'расписание выключено'];
      if (d.every) parts.push(d.every === 'weekly' ? 'раз в неделю' : 'каждый день');
      if (d.storage) parts.push(d.storage === 's3' ? 'хранилище S3' : 'хранение на сервере');
      if (d.keep != null) parts.push(`хранить копий: ${typeof d.keep === 'object' ? Object.values(d.keep).join('/') : d.keep}`);
      return parts.map((x) => t(x)).join(' · ');
    } catch { return detail; }
  }
  return detail;
}
