// Firma de Windows con SSL.com eSigner (certificado OV en HSM en la nube).
//
// electron-builder llama a esta función por cada .exe que firma: el ejecutable de
// la app, el desinstalador y el Setup.exe. Firmamos acá, dentro de electron-builder,
// y no después, porque latest.yml guarda el sha512 del instalador: si se firmara
// a posteriori el hash dejaría de coincidir y el auto-update fallaría.
//
// Sin credenciales (build local, PRs, workflow_dispatch) no firma y sale sin error:
// el workflow solo pasa las variables ES_* en los builds de tag v*.
//
// Variables:
//   ES_USERNAME, ES_PASSWORD, ES_CREDENTIAL_ID, ES_TOTP_SECRET  → secrets de GitHub
//   CODESIGNTOOL_DIR → carpeta de CodeSignTool descomprimida (la prepara el workflow)

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const CODESIGNTOOL_JAR = 'code_sign_tool-1.3.2.jar'

function alreadySigned(file) {
  // Los .exe de terceros que ya vienen firmados (p. ej. el claude.exe del Agent SDK)
  // se dejan como están: conservan la firma de su editor y no gastan firmas del plan.
  if (process.platform !== 'win32') return false
  const literal = file.replace(/'/g, "''")
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const status = execFileSync(
    powershell,
    ['-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${literal}').Status`],
    { encoding: 'utf8' }
  ).trim()
  return status === 'Valid'
}

module.exports = async function sign(configuration) {
  const file = configuration.path
  const { ES_USERNAME, ES_PASSWORD, ES_CREDENTIAL_ID, ES_TOTP_SECRET, CODESIGNTOOL_DIR } = process.env

  if (!ES_USERNAME || !ES_PASSWORD || !ES_CREDENTIAL_ID || !ES_TOTP_SECRET) {
    console.log(`[sign-esigner] sin credenciales de eSigner, no se firma: ${path.basename(file)}`)
    return
  }
  if (!CODESIGNTOOL_DIR) {
    throw new Error('[sign-esigner] hay credenciales pero falta CODESIGNTOOL_DIR')
  }
  if (alreadySigned(file)) {
    console.log(`[sign-esigner] ya firmado por su editor, se deja igual: ${path.basename(file)}`)
    return
  }

  const java = path.join(CODESIGNTOOL_DIR, 'jdk-11.0.2', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  const jar = path.join(CODESIGNTOOL_DIR, 'jar', CODESIGNTOOL_JAR)
  if (!fs.existsSync(java) || !fs.existsSync(jar)) {
    throw new Error(`[sign-esigner] CodeSignTool incompleto en ${CODESIGNTOOL_DIR}`)
  }

  console.log(`[sign-esigner] firmando ${path.basename(file)}`)
  // Llamamos a java directo y no a CodeSignTool.bat: el .bat no entrecomilla las
  // rutas y se rompe con espacios («CERP AI.exe»). cwd = CODESIGNTOOL_DIR porque
  // la herramienta lee conf/code_sign_tool.properties en forma relativa.
  // Las credenciales van por argumentos y no se imprimen nunca.
  let output
  try {
    output = execFileSync(
      java,
      [
        '-jar', jar, 'sign',
        `-username=${ES_USERNAME}`,
        `-password=${ES_PASSWORD}`,
        `-credential_id=${ES_CREDENTIAL_ID}`,
        `-totp_secret=${ES_TOTP_SECRET}`,
        `-input_file_path=${file}`,
        '-override'
      ],
      { cwd: CODESIGNTOOL_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch (e) {
    throw new Error(`[sign-esigner] CodeSignTool falló en ${path.basename(file)}: ${e.stdout || ''}${e.stderr || ''}`)
  }

  // CodeSignTool puede terminar con código 0 aunque la firma haya fallado:
  // el único dato fiable es el texto que imprime («Code signed successfully: …»
  // o «Error: …», verificado en SignCommand de la v1.3.2).
  console.log(output.trim())
  if (/^\s*Error:/m.test(output) || !/Code signed successfully/.test(output)) {
    throw new Error(`[sign-esigner] CodeSignTool no confirmó la firma de ${path.basename(file)}`)
  }
}
