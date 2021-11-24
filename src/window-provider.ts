import EventEmitter from "events"

const PROVIDER_BRIDGE_TARGET = "tally-provider-bridge"
const WINDOW_PROVIDER_TARGET = "tally-window-provider"

// We want our own functions to minimize tampering.
// We still consider them unsafe because there's no guarantee they weren't tampered with before we stored them.
// For 100% certainty we could create an iframe here, store the references and then destoroy the iframe.
//   something like this: https://speakerdeck.com/fransrosen/owasp-appseceu-2018-attacking-modern-web-technologies?slide=95
const unsafePostMessage = window.postMessage
const unsafeAddEventListener = window.addEventListener
const unsafeRemoveEventListener = window.removeEventListener
const unsafeOrigin = window.location.origin

const WINDOW_PROVIDER_FLAG = "isTallyWindowProviderEnabled"

const enabled = window.localStorage.getItem(WINDOW_PROVIDER_FLAG)

class TallyWindowProvider extends EventEmitter {
  // TODO: This should come from the background with onConnect when any interaction is initiated by the dApp.
  // onboard.js relies on this, or uses a deprecated api. It seemed to be a reasonable workaround for now.
  chainId: number | undefined = 1

  selectedAddress: string | undefined

  isConnected = false

  isTally = true

  bridgeListeners = new Map()

  async request(request: {
    method: string
    params?: Array<unknown>
  }): Promise<unknown> {
    return this.send(request.method, request.params || [])
  }

  async send(method: string, params?: Array<unknown>): Promise<unknown> {
    const sendData = {
      id: Date.now().toString(),
      target: PROVIDER_BRIDGE_TARGET,
      payload: {
        method,
        params,
      },
    }

    // ‼️ Always include target origin to only trigger frames with the same origin as ours.
    unsafePostMessage(sendData, unsafeOrigin)

    return new Promise((resolve) => {
      // TODO: refactor the listener function out of the Promise
      function listener(
        this: TallyWindowProvider,
        event: {
          origin: string
          source: unknown
          data: { id: string; target: string; payload: { result: unknown } }
        }
      ) {
        if (
          event.origin === unsafeOrigin && // filter to messages claiming to be from the provider-bridge script
          event.source === window && // we want to recieve messages only from the provider-bridge script
          event.data.target === WINDOW_PROVIDER_TARGET
        ) {
          if (sendData.id !== event.data.id) return

          unsafeRemoveEventListener(
            "message",
            this.bridgeListeners.get(sendData.id),
            false
          )
          this.bridgeListeners.delete(sendData.id)

          const { method: sentMethod } = sendData.payload
          const { result } = event.data.payload

          // TODOO: refactor these into their own function handler
          // https://github.com/tallycash/tally-extension/pull/440#discussion_r753504700
          if (sentMethod === "eth_chainId") {
            if (!this.isConnected) {
              this.isConnected = true
              this.emit("connect", { chainId: result })
            }

            if (this.chainId !== result) {
              this.chainId = Number(result)
              this.emit("chainChanged", result)
              this.emit("networkChanged", result)
            }
          }

          if (
            sentMethod === "eth_accounts" &&
            Array.isArray(result) &&
            result.length !== 0
          ) {
            const [address] = result
            if (this.selectedAddress !== address) {
              this.selectedAddress = address
              this.emit("accountsChanged", [this.selectedAddress])
            }
          }

          resolve(result)
        }
      }

      this.bridgeListeners.set(sendData.id, listener.bind(this))
      // TODO: refactor this to have a single `unsafeAddEventListener` call in the constructor
      // https://github.com/tallycash/tally-extension/pull/440#discussion_r753509947
      unsafeAddEventListener("message", this.bridgeListeners.get(sendData.id))
    })
  }
}

if (enabled === "true") {
  // @ts-expect-error I don't really have any way to know the exact type of window.ethereum so it's better to expect error than lie
  window.ethereum = new TallyWindowProvider()
}