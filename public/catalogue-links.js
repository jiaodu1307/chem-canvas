import {workspacePageUrl} from './workspace-context.js';
for(const link of document.querySelectorAll('[data-workspace]'))link.href=workspacePageUrl(link.getAttribute('href'));
