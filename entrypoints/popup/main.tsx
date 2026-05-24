import '../../src/popup/popup.css';
import { render } from 'preact';
import { PopupApp } from '../../src/popup/PopupApp';

render(<PopupApp />, document.getElementById('app')!);
